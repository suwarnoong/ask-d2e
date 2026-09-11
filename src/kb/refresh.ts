import { join } from "node:path";
import { required, optional, taskModel, parseWebhooks, type ClaudeAuth } from "../shared/config.js";
import { callClaude as realCallClaude } from "../shared/claude.js";
import { gatherRepoPrs as realGatherRepoPrs } from "../shared/githubDiff.js";
import { postBlocks, toSlackMrkdwn, chunkText, type Block } from "../shared/slackBlocks.js";
import { buildIncrementalPrompt } from "./incrementalPrompt.js";
import { parseKbResponse, type KbPlan } from "./responseParsing.js";
import { applyKbChanges, readRepoKb, renderKb } from "./kbFiles.js";
import { commitAndPushMany, cloneSourceRepo as realCloneSourceRepo } from "./gitOps.js";
import { loadRegistry, isDue, cadenceWindowMs, withRegistryRetry, type RegistryEntry } from "./registry.js";
import { triggerDeployHook } from "./initialBuild.js";

export interface RefreshConfig extends ClaudeAuth {
  kbRepoToken: string;
  sourceReposToken: string;
  kbTargetBranch: string;
  dryRun: boolean;
  skipIfEmpty: boolean;
  force: boolean;
  kbRoot: string;
  workDir: string;
  deployHookUrl: string;
}

export function loadRefreshConfig(): RefreshConfig {
  return {
    claudeOauthToken: required("CLAUDE_CODE_OAUTH_TOKEN"),
    claudeModel: taskModel("REFRESH_MODEL", "claude-sonnet-4-5"),
    kbRepoToken: required("KB_REPO_TOKEN"),
    sourceReposToken: required("SOURCE_REPOS_TOKEN"),
    kbTargetBranch: optional("KB_TARGET_BRANCH", "main"),
    dryRun: optional("KB_DRY_RUN", "false") === "true",
    skipIfEmpty: optional("SKIP_IF_EMPTY", "true") === "true",
    force: optional("FORCE_REFRESH", "false") === "true",
    kbRoot: optional("KB_ROOT", "./kb"),
    workDir: optional("WORK_DIR", "./src-checkout"),
    deployHookUrl: optional("DEPLOY_HOOK_URL", ""),
  };
}

export interface RefreshDeps {
  callClaude: typeof realCallClaude;
  gatherRepoPrs: typeof realGatherRepoPrs;
  cloneSourceRepo: typeof realCloneSourceRepo;
  notify: (text: string) => Promise<void>;
  now: Date;
}

export interface ProcessedEntry {
  entry: RegistryEntry;
  plan: KbPlan;
  prCount: number;
}

async function defaultNotify(text: string): Promise<void> {
  const raw = process.env.SLACK_WEBHOOK_URLS;
  if (!raw) return;
  const blocks: Block[] = chunkText(toSlackMrkdwn(text)).map((c) => ({
    type: "section",
    text: { type: "mrkdwn", text: c },
  }));
  await postBlocks(parseWebhooks(raw), blocks, text).catch(() => {});
}

export function summarize(processed: ProcessedEntry[]): string {
  const lines = processed.map(({ entry, plan, prCount }) => {
    const count = plan.changes.length;
    const changed = count === 0 ? "no changes needed" : `${count} page(s) updated`;
    return `- *${entry.name}* — ${prCount} merged PR(s), ${changed}`;
  });
  return [`KB refresh — ${processed.length} repo(s) processed:`, ...lines].join("\n");
}

export async function runRefresh(config: RefreshConfig, deps: Partial<RefreshDeps> = {}): Promise<void> {
  const callClaude = deps.callClaude ?? realCallClaude;
  const gatherRepoPrs = deps.gatherRepoPrs ?? realGatherRepoPrs;
  const cloneSourceRepo = deps.cloneSourceRepo ?? realCloneSourceRepo;
  const notify = deps.notify ?? defaultNotify;
  const now = deps.now ?? new Date();

  const registry = loadRegistry(config.kbRoot);
  // A pending-initial-build entry has no KB pages to bring up to date yet — skip it entirely
  // rather than let its null lastRefreshedAt read as "due".
  // `force` overrides the cadence gate only — a pending-initial-build entry still has no KB
  // pages to bring up to date, so it stays excluded either way.
  const due = registry.filter((e) => e.status === "active" && (config.force || isDue(e, now)));
  if (due.length === 0) {
    console.log(config.force ? "No active repos in the registry." : "No repos are due for refresh.");
    return;
  }
  const label = config.force ? "Forced refresh (cadence ignored)" : "Due for refresh";
  console.log(`${label}: ${due.map((e) => e.name).join(", ")}`);

  const processed: ProcessedEntry[] = [];
  for (const entry of due) {
    const sinceIso =
      entry.lastRefreshedAt ?? new Date(now.getTime() - cadenceWindowMs(entry.cadence)).toISOString();
    const data = await gatherRepoPrs(entry.sourceRepo, sinceIso, config.sourceReposToken);

    if (data.totals.prCount === 0 && config.skipIfEmpty) {
      // Deliberately NOT marked processed: lastRefreshedAt stays put so the next run widens the
      // same window rather than silently skipping past a quiet period.
      console.log(`${entry.name}: no merged PRs since ${sinceIso} — skipping.`);
      continue;
    }

    const sourceDir = join(config.workDir, entry.name);
    cloneSourceRepo(entry.sourceRepo, config.sourceReposToken, sourceDir);

    const renderedKb = renderKb(readRepoKb(config.kbRoot, entry.name));
    const prompt = buildIncrementalPrompt(entry.sourceRepo, entry.name, entry.promptSpec, data, renderedKb);
    const plan = parseKbResponse(
      await callClaude(prompt, config, { cwd: sourceDir, allowedTools: ["Read", "Grep", "Glob"] }),
    );

    if (plan.changes.length > 0) applyKbChanges(plan.changes, config.kbRoot, entry.name);
    // An empty-changes result on a due repo is a normal, successful refresh — still processed.
    processed.push({ entry, plan, prCount: data.totals.prCount });
    console.log(`${entry.name}: ${data.totals.prCount} PR(s), ${plan.changes.length} change(s).`);
  }

  if (processed.length === 0) {
    console.log("Every due repo had no merged PRs in its window — nothing to commit.");
    return;
  }

  if (config.dryRun) {
    console.log("[KB_DRY_RUN] would commit:", processed.flatMap((p) => p.plan.changes.map((c) => c.path)));
    console.log("[KB_DRY_RUN] would bump lastRefreshedAt for:", processed.map((p) => p.entry.name));
    return;
  }

  // Order matters: the markdown is committed and pushed BEFORE the registry bump, because
  // withRegistryRetry starts each attempt with `git reset --hard origin/<branch>` — which would
  // discard uncommitted edits to tracked KB files. Once pushed, that reset lands on a commit
  // that already contains them. The registry stays a separate, retry-safe write because
  // repos.json is the one file genuinely prone to races with the wizard/correction flows.
  const names = processed.map((p) => p.entry.name);
  const wrote = commitAndPushMany(
    config.kbRoot,
    processed.map(({ entry, plan }) => ({ repoName: entry.name, plan })),
    config.kbTargetBranch,
    `docs(kb): scheduled refresh for ${names.join(", ")}`,
  );

  const nowIso = now.toISOString();
  const processedNames = new Set(names);
  await withRegistryRetry(
    config.kbRoot,
    config.kbTargetBranch,
    (entries) =>
      entries.map((e) => (processedNames.has(e.name) ? { ...e, lastRefreshedAt: nowIso } : e)),
    `chore(kb): bump lastRefreshedAt for ${names.join(", ")}`,
  );

  if (wrote) await triggerDeployHook(config.deployHookUrl || undefined);
  await notify(summarize(processed)).catch(() => {});
}

async function main() {
  const config = loadRefreshConfig();
  await runRefresh(config);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
