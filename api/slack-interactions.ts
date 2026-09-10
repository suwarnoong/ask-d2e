import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { verifySlackSignature, isAdmin, adminIds, friendlyError } from "../src/shared/slackAuth.js";
import { postMessage, openDm, updateMessage } from "./_lib/slackApi.js";
import { resolveRepoFromCitation, classifyRepoForQuestion } from "../src/kb/repoResolution.js";
import { loadRegistry, type RegistryEntry } from "../src/kb/registry.js";
import { buildCorrectDispatchPayload } from "./_lib/selfHeal.js";
import { readRawBody } from "./_lib/rawBody.js";
import type { Block } from "../src/shared/slackBlocks.js";

export const config = { api: { bodyParser: false } };

export type InteractionRoute = "thanks" | "notify-admin" | "admin-confirm" | "admin-dismiss" | "ignored";

export function routeInteraction(actionId: string): InteractionRoute {
  switch (actionId) {
    case "feedback_up":
      return "thanks";
    case "feedback_down":
      return "notify-admin";
    case "admin_fix_confirm":
      return "admin-confirm";
    case "admin_fix_dismiss":
      return "admin-dismiss";
    default:
      return "ignored";
  }
}

// When citation/classification can't pin down a repo but there's exactly one active repo
// configured, that's unambiguously the target — default to it so admins still get a
// "Refresh KB & Answer" button instead of a dead-end "couldn't determine" note.
export function soleActiveRepo(registry: RegistryEntry[]): string | null {
  const active = registry.filter((e) => e.status === "active");
  return active.length === 1 ? active[0].name : null;
}

export interface FixContext {
  repoName: string;
  question: string;
  answer: string;
  channelId: string;
  messageTs: string;
}

// Truncated well under Slack's ~2000-char button value limit — buildCorrectDispatchPayload
// caps question/answer to 1024 chars for the GitHub Actions dispatch anyway.
export function packFixContext(ctx: FixContext): string {
  return JSON.stringify({
    repoName: ctx.repoName,
    question: ctx.question.slice(0, 300),
    answer: ctx.answer.slice(0, 800),
    channelId: ctx.channelId,
    messageTs: ctx.messageTs,
  });
}

export function unpackFixContext(value: string): FixContext | null {
  try {
    const parsed = JSON.parse(value);
    if (
      typeof parsed.repoName === "string" &&
      typeof parsed.question === "string" &&
      typeof parsed.answer === "string" &&
      typeof parsed.channelId === "string" &&
      typeof parsed.messageTs === "string"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

// Rebuilds a bot-owned message's blocks for the post-click state: strips the feedback/admin
// buttons (so they can't be double-clicked) and appends a small confirmation line.
export function buildConfirmationBlocks(messageBlocks: Block[], confirmationText: string): Block[] {
  return [
    ...messageBlocks.filter((b) => b.type !== "actions"),
    { type: "context", elements: [{ type: "mrkdwn", text: confirmationText }] },
  ];
}

async function postEphemeral(responseUrl: string, text: string): Promise<void> {
  if (!responseUrl) return;
  await fetch(responseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }),
  }).catch((err) => console.error("response_url confirmation failed:", friendlyError(err)));
}

// Confirms a click in the nicest way available. If the message is bot-owned (@mention answers,
// admin DMs — real chat.postMessage messages), edit it in place via chat.update, replacing the
// buttons with a small confirmation line. That fails for messages posted via response_url
// (e.g. /ask answers in a channel): they carry payload.message but are owned by a synthetic,
// un-updatable bot identity, so chat.update returns cant_update_message — in that case (and
// when there's no message at all, e.g. /ask in a DM) fall back to an ephemeral reply.
async function confirmClick(opts: {
  botToken: string;
  channelId: string;
  messageTs: string;
  messageBlocks: Block[] | null;
  responseUrl: string;
  text: string;
}): Promise<void> {
  if (opts.messageBlocks && opts.channelId && opts.messageTs) {
    try {
      const blocks = buildConfirmationBlocks(opts.messageBlocks, opts.text);
      await updateMessage({ botToken: opts.botToken, channel: opts.channelId, ts: opts.messageTs, text: opts.text, blocks });
      return;
    } catch (err) {
      console.error("chat.update confirmation failed, falling back to ephemeral:", friendlyError(err));
    }
  }
  await postEphemeral(opts.responseUrl, opts.text);
}

async function notifyAdminsOfFlag(
  botToken: string,
  userId: string,
  question: string,
  answerText: string,
  repoName: string | null,
  channelId: string,
  messageTs: string,
): Promise<void> {
  const preview = answerText.length > 500 ? `${answerText.slice(0, 500)}...` : answerText;
  const blocks: Block[] = [
    { type: "section", text: { type: "mrkdwn", text: `*Flagged by <@${userId}>*\n*Q:* ${question}\n*A:* ${preview}` } },
  ];
  if (repoName) {
    const value = packFixContext({ repoName, question, answer: answerText, channelId, messageTs });
    blocks.push({
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "🔄 Refresh KB & Answer" }, action_id: "admin_fix_confirm", value, style: "primary" },
        // Slack rejects an empty button value ("invalid_blocks: must be more than 0 characters"),
        // so give Dismiss a non-empty placeholder — its value is never read (routed by action_id).
        { type: "button", text: { type: "plain_text", text: "✖️ Dismiss" }, action_id: "admin_fix_dismiss", value: "dismiss" },
      ],
    });
  } else {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_Couldn't determine which configured repo this belongs to — may need manual follow-up._" },
    });
  }
  const results = await Promise.allSettled(
    [...adminIds()].map(async (adminId) => {
      const channel = await openDm(botToken, adminId);
      await postMessage({ botToken, channel, text: `Flagged by <@${userId}>: "${question}"`, blocks });
    }),
  );
  // Don't let a failed DM vanish silently (that's how the empty-button-value bug hid) —
  // log rejections so they're visible in the function logs.
  for (const r of results) {
    if (r.status === "rejected") console.error("notifyAdminsOfFlag: admin DM failed:", friendlyError(r.reason));
  }
}

async function dispatchCorrectFix(
  repoName: string,
  question: string,
  answer: string,
  askedBy: string,
  slackChannel: string,
  slackThreadTs: string,
): Promise<void> {
  const payload = buildCorrectDispatchPayload("fix", repoName, question, answer, askedBy, slackChannel, slackThreadTs);
  const res = await fetch(`https://api.github.com/repos/suwarnoong/ask-d2e/actions/workflows/kb-correct.yml/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.GITHUB_DISPATCH_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`workflow_dispatch failed: ${res.status}`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const rawBody = await readRawBody(req);
  const ok = verifySlackSignature(
    rawBody,
    (req.headers["x-slack-signature"] as string) ?? null,
    (req.headers["x-slack-request-timestamp"] as string) ?? null,
    process.env.SLACK_SIGNING_SECRET!,
  );
  if (!ok) {
    res.status(401).send("invalid signature");
    return;
  }

  const params = new URLSearchParams(rawBody);
  const payload = JSON.parse(params.get("payload") ?? "{}");
  if (payload.type !== "block_actions") {
    res.status(200).send("");
    return;
  }

  const action = payload.actions?.[0];
  const actionId = (action?.action_id as string) ?? "";
  const userId = payload.user?.id ?? "";
  const actionValue = (action?.value as string) ?? "";
  const question = actionValue;
  // payload.message is only present for bot-owned (chat.postMessage-origin) messages — track
  // that distinctly from "message exists but has zero blocks" so confirmClick can tell whether
  // it's safe to rebuild blocks or must fall back to an ephemeral reply.
  const hasMessage = Boolean(payload.message);
  const messageBlocks: Block[] | null = hasMessage ? ((payload.message?.blocks ?? []) as Block[]) : null;
  const answerText = (messageBlocks ?? [])
    .filter((b): b is Extract<Block, { type: "section" }> => b.type === "section")
    .map((b) => b.text.text)
    .join("\n");
  const responseUrl = (payload.response_url as string) ?? "";
  const channelId = payload.channel?.id ?? "";
  const messageTs = payload.message?.ts ?? "";

  res.status(200).send("");

  const botToken = process.env.SLACK_BOT_TOKEN!;
  const route = routeInteraction(actionId);

  // The response above already went out — Vercel doesn't guarantee this invocation stays
  // alive for the async work below unless it's wrapped in waitUntil().
  waitUntil(
    processInteraction(
      route,
      botToken,
      userId,
      isAdmin(userId),
      question,
      answerText,
      messageBlocks,
      responseUrl,
      channelId,
      messageTs,
      actionValue,
    ),
  );
}

async function processInteraction(
  route: InteractionRoute,
  botToken: string,
  userId: string,
  isAdminUser: boolean,
  question: string,
  answerText: string,
  messageBlocks: Block[] | null,
  responseUrl: string,
  channelId: string,
  messageTs: string,
  actionValue: string,
): Promise<void> {
  const confirm = (text: string) => confirmClick({ botToken, channelId, messageTs, messageBlocks, responseUrl, text });

  try {
    if (route === "thanks") {
      await confirm("✅ Thanks for the feedback!");
      return;
    }

    if (route === "notify-admin") {
      await confirm("👀 Thanks — flagged for the team to review.");
      console.log(`KB feedback (down) from ${userId}: ${question}`);
      const registry = loadRegistry(process.env.KB_ROOT ?? process.cwd() + "/knowledge-base");
      let repoName = resolveRepoFromCitation(answerText);
      if (!repoName) {
        repoName = await classifyRepoForQuestion(question, registry);
      }
      if (!repoName) {
        repoName = soleActiveRepo(registry);
      }
      await notifyAdminsOfFlag(botToken, userId, question, answerText, repoName, channelId, messageTs);
      return;
    }

    if (route === "admin-dismiss") {
      await confirm("Dismissed.");
      return;
    }

    if (route === "admin-confirm") {
      if (!isAdminUser) {
        await confirm("Only admins can do that.");
        return;
      }
      const ctx = unpackFixContext(actionValue);
      if (!ctx) {
        await confirm("Something went wrong reading that action — try again.");
        return;
      }
      await dispatchCorrectFix(ctx.repoName, ctx.question, ctx.answer, userId, ctx.channelId, ctx.messageTs);
      await confirm("✅ Dispatched — I'll post the result in the original thread once it's done.");
      return;
    }
  } catch (err) {
    console.error(friendlyError(err));
  }
}
