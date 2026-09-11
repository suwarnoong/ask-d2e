import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { verifySlackSignature } from "../src/shared/slackAuth.js";
import { getThreadReplies, getThreadMessages, getBotUserId, postMessage, stripMention, mapHistoryToTurns, type SlackHistoryMessage } from "./_lib/slackApi.js";
import { answerInThread } from "./_lib/answerFlow.js";
import { readRawBody } from "./_lib/rawBody.js";

// Slack HMAC-signs the exact raw request bytes — disable Vercel's automatic
// body parsing so readRawBody() sees the unparsed stream, not a reconstructed
// (and signature-breaking) re-serialization of an already-parsed body.
export const config = { api: { bodyParser: false } };

export interface SlackEventPayload {
  type: string;
  challenge?: string;
  event?: {
    type: string;
    subtype?: string;
    user?: string;
    bot_id?: string;
    channel?: string;
    channel_type?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
  };
}

export type EventClassification =
  | "url_verification"
  | "retry"
  | "self"
  | "dm_question"
  | "app_mention"
  | "thread_followup"
  | "ignored";

export function classifyEvent(payload: SlackEventPayload, botUserId: string, isRetry: boolean): EventClassification {
  if (payload.type === "url_verification") return "url_verification";
  if (isRetry) return "retry";

  const event = payload.event;
  if (!event) return "ignored";
  // Never react to our own messages (avoids answer→message-event→answer loops).
  if (event.user === botUserId || event.bot_id) return "self";
  if (event.type === "app_mention") return "app_mention";

  if (event.type === "message") {
    if (event.subtype) return "ignored"; // edits, joins, deletes, etc. — not a user message
    if (event.channel_type === "im") return "dm_question"; // a DM is a direct question — no @mention needed
    const text = event.text ?? "";
    // Tags the bot → let the app_mention event handle it, so we don't answer twice.
    if (text.includes(`<@${botUserId}>`)) return "ignored";
    // Tags someone else (but not the bot) → the author is addressing that person, not us. Stay out.
    if (/<@[^>]+>/.test(text)) return "ignored";
    // Untagged reply inside an existing thread → candidate follow-up. processEvent confirms the
    // bot participated AND that the author owns the thread before answering.
    if (event.thread_ts && event.thread_ts !== event.ts) return "thread_followup";
    return "ignored";
  }
  return "ignored";
}

export type ThreadFollowupDecision = "answer" | "not-participant" | "not-owner";

// Untagged replies in a thread are only answered for the person who started the thread (the
// author of its root message). Anyone else must @mention the bot (which routes to app_mention).
// The bot must also have taken part in the thread — otherwise it's an unrelated conversation.
export function threadFollowupDecision(
  messages: SlackHistoryMessage[],
  replyUserId: string,
  botUserId: string,
): ThreadFollowupDecision {
  const botParticipated = messages.some((m) => Boolean(m.bot_id) || m.user === botUserId);
  if (!botParticipated) return "not-participant";
  const owner = messages[0]?.user; // conversations.replies returns the root message first
  if (!owner || replyUserId !== owner) return "not-owner";
  return "answer";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const rawBody = await readRawBody(req);
  const payload: SlackEventPayload = JSON.parse(rawBody);

  if (payload.type === "url_verification") {
    res.status(200).json({ challenge: payload.challenge });
    return;
  }

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

  const botToken = process.env.SLACK_BOT_TOKEN!;
  const botUserId = await getBotUserId(botToken);
  const isRetry = Boolean(req.headers["x-slack-retry-num"]);
  const classification = classifyEvent(payload, botUserId, isRetry);

  res.status(200).send("");
  if (classification === "retry" || classification === "self" || classification === "ignored") return;

  const event = payload.event!;
  // Sending the response above does NOT guarantee Vercel keeps this invocation alive for the
  // async work below — the instance can be frozen/recycled right after the response flushes.
  // waitUntil() is the platform's primitive for "keep running this promise in the background
  // even though the response already went out."
  waitUntil(processEvent(classification, payload, event, botToken, botUserId));
}

async function processEvent(
  classification: EventClassification,
  payload: SlackEventPayload,
  event: NonNullable<SlackEventPayload["event"]>,
  botToken: string,
  botUserId: string,
): Promise<void> {
  console.log(`slack-events: classification=${classification} user=${event.user} channel=${event.channel} subtype=${(event as { subtype?: string }).subtype ?? "none"}`);

  try {
    // @mention and DM are identical: a direct question that threads the answer under the
    // asking message (its thread if it's already in one). No @mention needed inside a DM.
    if (classification === "app_mention" || classification === "dm_question") {
      const question = stripMention(event.text ?? "", botUserId);
      const parentThreadTs = event.thread_ts ?? event.ts!;
      const isFollowUp = event.thread_ts !== undefined && event.thread_ts !== event.ts;
      const history = isFollowUp
        ? await getThreadReplies(botToken, event.channel!, parentThreadTs, botUserId, event.ts)
        : [];
      await answerInThread({ botToken, channel: event.channel!, question, history, parentThreadTs });
      return;
    }

    if (classification === "thread_followup") {
      const parentThreadTs = event.thread_ts!;
      const messages = await getThreadMessages(botToken, event.channel!, parentThreadTs);
      const decision = threadFollowupDecision(messages, event.user!, botUserId);
      if (decision !== "answer") {
        // not-participant: unrelated thread. not-owner: only the thread starter gets untagged
        // answers — anyone else must @mention the bot.
        console.log(`thread_followup: ${decision} — ignoring (user=${event.user})`);
        return;
      }
      const history = mapHistoryToTurns(messages, botUserId, event.ts);
      const question = stripMention(event.text ?? "", botUserId);
      await answerInThread({ botToken, channel: event.channel!, question, history, parentThreadTs });
      return;
    }
  } catch (err) {
    console.error("slack-events handler error:", err);
    const event2 = payload.event;
    if (event2?.channel) {
      await postMessage({
        botToken,
        channel: event2.channel,
        text: "Sorry, something went wrong answering that.",
        thread_ts: event2.thread_ts ?? event2.ts,
      }).catch(() => {});
    }
  }
}
