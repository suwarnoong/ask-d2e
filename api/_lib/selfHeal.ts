import { canAutoRefresh, withRegistryRetry, loadRegistry, type RegistryEntry } from "../../src/kb/registry.js";
import { classifyRepoForQuestion } from "../../src/kb/repoResolution.js";
import { adminIds } from "../../src/shared/slackAuth.js";
import { postMessage, openDm } from "./slackApi.js";

export type SelfHealDecision = { action: "dispatch"; repoName: string } | { action: "admin-fallback" };

export async function decideSelfHealAction(
  question: string,
  registry: RegistryEntry[],
  now: Date,
  classify: (q: string, r: RegistryEntry[]) => Promise<string | null>,
): Promise<SelfHealDecision> {
  const repoName = await classify(question, registry);
  if (!repoName) return { action: "admin-fallback" };

  const entry = registry.find((e) => e.name === repoName);
  if (!entry || !canAutoRefresh(entry, now)) return { action: "admin-fallback" };

  return { action: "dispatch", repoName };
}

const GITHUB_INPUT_CAP = 1024;

function cap(s: string): string {
  return s.slice(0, GITHUB_INPUT_CAP);
}

export function buildCorrectDispatchPayload(
  mode: "fix" | "gap-fill",
  repoName: string,
  question: string,
  answer: string,
  askedBy: string,
  slackChannel?: string,
  slackThreadTs?: string,
): { ref: string; inputs: Record<string, string> } {
  return {
    ref: "main",
    inputs: {
      mode,
      repo_name: repoName,
      question: cap(question),
      answer: cap(answer),
      asked_by: askedBy,
      slack_channel: slackChannel ?? "",
      slack_thread_ts: slackThreadTs ?? "",
    },
  };
}

async function dispatchWorkflow(payload: { ref: string; inputs: Record<string, string> }): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/suwarnoong/ask-d2e/actions/workflows/kb-correct.yml/dispatches`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.GITHUB_DISPATCH_TOKEN}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) throw new Error(`workflow_dispatch failed: ${res.status}`);
}

async function dmAllAdmins(botToken: string, text: string): Promise<void> {
  const results = await Promise.allSettled(
    [...adminIds()].map(async (userId) => {
      const channel = await openDm(botToken, userId);
      await postMessage({ botToken, channel, text });
    }),
  );
  void results;
}

export async function maybeStartSelfHeal(opts: {
  question: string;
  slackChannel?: string;
  slackThreadTs?: string;
  respondViaResponseUrl?: string;
}): Promise<void> {
  const kbRoot = process.env.KB_ROOT ?? process.cwd() + "/knowledge-base";
  const botToken = process.env.SLACK_BOT_TOKEN!;
  let registry: RegistryEntry[];
  try {
    registry = loadRegistry(kbRoot);
  } catch {
    registry = [];
  }

  const decision = await decideSelfHealAction(opts.question, registry, new Date(), classifyRepoForQuestion);

  if (decision.action === "admin-fallback") {
    await dmAllAdmins(botToken, `Couldn't answer: "${opts.question}" — no configured repo plausibly covers it (or it's cooling down).`);
    return;
  }

  const interim = "The knowledge base doesn't cover that yet — let me check the source and get back to you.";
  if (opts.slackChannel && opts.slackThreadTs) {
    await postMessage({ botToken, channel: opts.slackChannel, text: interim, thread_ts: opts.slackThreadTs });
  } else if (opts.respondViaResponseUrl) {
    await fetch(opts.respondViaResponseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_type: "in_channel", text: interim }),
    });
  }

  await dispatchWorkflow(
    buildCorrectDispatchPayload("gap-fill", decision.repoName, opts.question, interim, "", opts.slackChannel, opts.slackThreadTs),
  );

  await withRegistryRetry(
    kbRoot,
    process.env.KB_TARGET_BRANCH ?? "main",
    (entries) => entries.map((e) => (e.name === decision.repoName ? { ...e, lastAutoRefreshAt: new Date().toISOString() } : e)),
    `chore(kb): bump lastAutoRefreshAt for ${decision.repoName}`,
  );
}
