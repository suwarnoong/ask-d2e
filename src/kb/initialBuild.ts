import { required, optional, taskModel, type ClaudeAuth } from "../shared/config.js";
import { callClaude as realCallClaude } from "../shared/claude.js";
import { listSourceFiles, readReadmes, buildInitialBuildPrompt } from "./initialBuildPrompt.js";
import { parseKbResponse } from "./responseParsing.js";
import { applyKbChanges } from "./kbFiles.js";
import { commitAndPush } from "./gitOps.js";
import { withRegistryRetry, type RegistryEntry, type PromptSpec } from "./registry.js";
import { postMessage as realPostMessage, openDm as realOpenDm } from "../../api/_lib/slackApi.js";

export interface InitialBuildConfig extends ClaudeAuth {
  kbRepoToken: string;
  sourceReposToken: string;
  kbTargetBranch: string;
  dryRun: boolean;
  repoName: string;
  sourceRepo: string;
  promptSpecJson: string;
  cadence: "daily" | "weekly";
  createdBy: string;
  kbRoot: string;
  sourceDir: string;
}

export function loadInitialBuildConfig(): InitialBuildConfig {
  return {
    claudeOauthToken: required("CLAUDE_CODE_OAUTH_TOKEN"),
    claudeModel: taskModel("INITIAL_BUILD_MODEL", "claude-sonnet-4-5"),
    kbRepoToken: required("KB_REPO_TOKEN"),
    sourceReposToken: required("SOURCE_REPOS_TOKEN"),
    kbTargetBranch: optional("KB_TARGET_BRANCH", "main"),
    dryRun: optional("KB_DRY_RUN", "false") === "true",
    repoName: required("REPO_NAME"),
    sourceRepo: required("SOURCE_REPO"),
    promptSpecJson: required("PROMPT_SPEC_JSON"),
    cadence: (optional("CADENCE", "weekly") as "daily" | "weekly"),
    createdBy: optional("CREATED_BY", ""),
    kbRoot: optional("KB_ROOT", "./kb"),
    sourceDir: optional("SOURCE_DIR", "./src-checkout"),
  };
}

export async function triggerDeployHook(url?: string): Promise<void> {
  if (!url) return; // Phase 6 seam — no-op until the deploy hook is wired up
  await fetch(url, { method: "POST" });
}

export interface InitialBuildDeps {
  callClaude: typeof realCallClaude;
  postMessage: typeof realPostMessage;
  openDm: typeof realOpenDm;
}

export async function runInitialBuild(
  config: InitialBuildConfig,
  deps: Partial<InitialBuildDeps> = {},
): Promise<void> {
  const callClaude = deps.callClaude ?? realCallClaude;
  const postMessage = deps.postMessage ?? realPostMessage;
  const openDm = deps.openDm ?? realOpenDm;

  const promptSpec: PromptSpec = JSON.parse(config.promptSpecJson);
  const allFiles = listSourceFiles(config.sourceDir);
  const readmes = readReadmes(config.sourceDir);
  const totalFileCount = allFiles.length;
  const prompt = buildInitialBuildPrompt(config.sourceRepo, promptSpec, allFiles, readmes, totalFileCount);

  const rawResult = await callClaude(prompt, config, { cwd: config.sourceDir, allowedTools: ["Read", "Grep", "Glob"] });
  const plan = parseKbResponse(rawResult);

  if (config.dryRun) {
    console.log("[KB_DRY_RUN] would-be registry entry:", {
      name: config.repoName,
      sourceRepo: config.sourceRepo,
      promptSpec,
      cadence: config.cadence,
      status: "active",
    });
    console.log("[KB_DRY_RUN] plan.summary:", plan.summary);
    console.log("[KB_DRY_RUN] changed files:", plan.changes.map((c) => c.path));
    applyKbChanges(plan.changes, config.kbRoot, config.repoName);
    return;
  }

  applyKbChanges(plan.changes, config.kbRoot, config.repoName);

  const now = new Date().toISOString();
  await withRegistryRetry(
    config.kbRoot,
    config.kbTargetBranch,
    (entries) => {
      const entry: RegistryEntry = {
        name: config.repoName,
        sourceRepo: config.sourceRepo,
        promptSpec,
        cadence: config.cadence,
        status: "active",
        createdBy: config.createdBy,
        createdAt: now,
        lastRefreshedAt: now,
        lastAutoRefreshAt: null,
      };
      return [...entries.filter((e) => e.name !== config.repoName), entry];
    },
    `docs(kb): register ${config.repoName}`,
  );

  commitAndPush(config.kbRoot, plan, config.repoName, config.kbTargetBranch, `docs(kb): initial build for ${config.repoName}`);

  await triggerDeployHook(process.env.DEPLOY_HOOK_URL);

  if (config.createdBy) {
    const botToken = process.env.SLACK_BOT_TOKEN;
    if (botToken) {
      const channel = await openDm(botToken, config.createdBy);
      await postMessage({
        botToken,
        channel,
        text: `Knowledge base for \`${config.repoName}\` is ready — ${plan.changes.length} page(s) created.`,
      });
    }
  }
}

async function main() {
  const config = loadInitialBuildConfig();
  await runInitialBuild(config);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
