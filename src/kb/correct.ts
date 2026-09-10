import { required, optional, taskModel, type ClaudeAuth } from "../shared/config.js";
import { callClaude as realCallClaude } from "../shared/claude.js";
import { buildCorrectionPrompt } from "./correctionPrompt.js";
import { listSourceFiles, readReadmes, buildFileTreeOverview } from "./initialBuildPrompt.js";
import { parseKbResponse } from "./responseParsing.js";
import { applyKbChanges } from "./kbFiles.js";
import { commitAndPush } from "./gitOps.js";
import { loadRegistry } from "./registry.js";
import { postThreadReply, postBlocks } from "../shared/slackBlocks.js";
import { parseWebhooks } from "../shared/config.js";

export interface CorrectConfig extends ClaudeAuth {
  kbRepoToken: string;
  sourceReposToken: string;
  kbTargetBranch: string;
  dryRun: boolean;
  mode: "fix" | "gap-fill";
  repoName: string;
  question: string;
  answer: string;
  askedBy: string;
  slackChannel: string;
  slackThreadTs: string;
  kbRoot: string;
  sourceDir: string;
}

export function loadCorrectConfig(): CorrectConfig {
  return {
    claudeOauthToken: required("CLAUDE_CODE_OAUTH_TOKEN"),
    claudeModel: taskModel("CORRECT_MODEL", "claude-sonnet-4-5"),
    kbRepoToken: required("KB_REPO_TOKEN"),
    sourceReposToken: required("SOURCE_REPOS_TOKEN"),
    kbTargetBranch: optional("KB_TARGET_BRANCH", "main"),
    dryRun: optional("KB_DRY_RUN", "false") === "true",
    mode: required("MODE") as "fix" | "gap-fill",
    repoName: required("REPO_NAME"),
    question: required("QUESTION"),
    answer: optional("ANSWER", ""),
    askedBy: optional("ASKED_BY", ""),
    slackChannel: optional("SLACK_CHANNEL", ""),
    slackThreadTs: optional("SLACK_THREAD_TS", ""),
    kbRoot: optional("KB_ROOT", "./kb"),
    sourceDir: optional("SOURCE_DIR", "./src-checkout"),
  };
}

export interface CorrectDeps {
  callClaude: typeof realCallClaude;
  notify: (text: string) => Promise<void>;
}

async function defaultNotify(config: CorrectConfig, text: string): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (botToken && config.slackChannel && config.slackThreadTs) {
    try {
      await postThreadReply({
        botToken,
        channel: config.slackChannel,
        thread_ts: config.slackThreadTs,
        blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
        fallbackText: text,
      });
      return;
    } catch {
      // fall through to the webhook fallback below — notify failure is non-fatal either way
    }
  }
  const raw = process.env.SLACK_WEBHOOK_URLS;
  if (raw) {
    await postBlocks(parseWebhooks(raw), [{ type: "section", text: { type: "mrkdwn", text } }], text).catch(() => {});
  }
}

export async function runCorrect(config: CorrectConfig, deps: Partial<CorrectDeps> = {}): Promise<void> {
  const callClaude = deps.callClaude ?? realCallClaude;
  const notify = deps.notify ?? ((text: string) => defaultNotify(config, text));

  const registry = loadRegistry(config.kbRoot);
  const entry = registry.find((e) => e.name === config.repoName);
  if (!entry) throw new Error(`repo_name "${config.repoName}" not found in registry — refusing to guess.`);

  let prompt: string;
  if (config.mode === "fix") {
    prompt = buildCorrectionPrompt("fix", entry.sourceRepo, config.question, config.answer);
  } else {
    const files = listSourceFiles(config.sourceDir);
    const overview = buildFileTreeOverview(files, files.length, files.length);
    const readmes = readReadmes(config.sourceDir);
    prompt = buildCorrectionPrompt("gap-fill", entry.sourceRepo, config.question, config.answer, overview, readmes);
  }

  const rawResult = await callClaude(prompt, config, { cwd: config.sourceDir, allowedTools: ["Read", "Grep", "Glob"] });
  const plan = parseKbResponse(rawResult);

  if (plan.changes.length === 0) {
    const text =
      config.mode === "fix"
        ? `Reviewed, no change needed: ${plan.summary}`
        : `Still not covered: ${plan.summary}`;
    await notify(text);
    return;
  }

  if (config.dryRun) {
    console.log("[KB_DRY_RUN] would write:", plan.changes.map((c) => c.path));
    applyKbChanges(plan.changes, config.kbRoot, config.repoName);
    return;
  }

  applyKbChanges(plan.changes, config.kbRoot, config.repoName);
  const subject =
    config.mode === "fix"
      ? "docs(kb): correct answer flagged in Slack"
      : "docs(kb): fill gap found via Slack question";
  commitAndPush(config.kbRoot, plan, config.repoName, config.kbTargetBranch, subject);

  const notifyText =
    config.mode === "fix"
      ? `Corrected the KB: ${plan.summary}`
      : `Found something — updated the KB: ${plan.summary} (the live bot needs a redeploy to fully reflect this).`;
  await notify(notifyText).catch(() => {});
}

async function main() {
  const config = loadCorrectConfig();
  await runCorrect(config);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
