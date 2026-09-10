import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { verifySlackSignature, isAdmin, adminIds, friendlyError } from "../src/shared/slackAuth.js";
import { postMessage, openDm } from "./_lib/slackApi.js";
import { resolveRepoFromCitation, classifyRepoForQuestion } from "../src/kb/repoResolution.js";
import { loadRegistry } from "../src/kb/registry.js";
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

// Ephemeral reply via the interaction's own response_url — works regardless of how or where
// the original message was posted, and never risks touching (or losing) that message's content.
// chat.update was tried here and reliably failed with cant_update_message even with as_user
// set consistently on both post and update; not worth chasing further right now.
async function postEphemeral(responseUrl: string, text: string): Promise<void> {
  if (!responseUrl) return;
  await fetch(responseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }),
  }).catch((err) => console.error("response_url confirmation failed:", friendlyError(err)));
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
        { type: "button", text: { type: "plain_text", text: "✖️ Dismiss" }, action_id: "admin_fix_dismiss", value: "" },
      ],
    });
  } else {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_Couldn't determine which configured repo this belongs to — may need manual follow-up._" },
    });
  }
  await Promise.allSettled(
    [...adminIds()].map(async (adminId) => {
      const channel = await openDm(botToken, adminId);
      await postMessage({ botToken, channel, text: `Flagged by <@${userId}>: "${question}"`, blocks });
    }),
  );
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
  const answerText = ((payload.message?.blocks ?? []) as Block[])
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
    processInteraction(route, botToken, userId, isAdmin(userId), question, answerText, responseUrl, channelId, messageTs, actionValue),
  );
}

async function processInteraction(
  route: InteractionRoute,
  botToken: string,
  userId: string,
  isAdminUser: boolean,
  question: string,
  answerText: string,
  responseUrl: string,
  channelId: string,
  messageTs: string,
  actionValue: string,
): Promise<void> {
  const confirm = (text: string) => postEphemeral(responseUrl, text);

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
