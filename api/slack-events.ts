import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { verifySlackSignature, isAdmin } from "../src/shared/slackAuth.js";
import { getThreadReplies, getDmHistory, getBotUserId, postMessage, stripMention, type Turn } from "./_lib/slackApi.js";
import { applyWizardTurn } from "../src/admin/wizard/addRepoWizard.js";
import { answerQuestion } from "./_lib/answer.js";
import { buildAnswerBlocks } from "./ask.js";
import { maybeStartSelfHeal } from "./_lib/selfHeal.js";
import { hasKbCitation } from "../src/kb/repoResolution.js";
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
  | "wizard_turn"
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
    if (event.channel_type === "im") return "wizard_turn";
    // An @mention also arrives as a message.* event; let the app_mention event handle it
    // so we don't answer twice.
    if ((event.text ?? "").includes(`<@${botUserId}>`)) return "ignored";
    // Untagged reply inside an existing thread → candidate follow-up. processEvent confirms
    // the bot actually participated in the thread before answering.
    if (event.thread_ts && event.thread_ts !== event.ts) return "thread_followup";
    return "ignored";
  }
  return "ignored";
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
    if (classification === "wizard_turn") {
      if (!isAdmin(event.user)) {
        console.log(`wizard_turn ignored: user "${event.user}" is not in KB_FEEDBACK_ADMIN_IDS`);
        return;
      }
      const history = await getDmHistory(botToken, event.channel!);
      console.log(`wizard_turn: fetched ${history.length} DM history message(s)`);
      const result = await applyWizardTurn(history, event.text ?? "", event.user!);
      if (!result) {
        console.log("wizard_turn: applyWizardTurn found no active state — nothing to reply to");
        return;
      }
      await postMessage({ botToken, channel: event.channel!, text: result.reply });
      if (result.dispatch) {
        await fetch("https://api.github.com/repos/suwarnoong/ask-d2e/actions/workflows/kb-initial-build.yml/dispatches", {
          method: "POST",
          headers: {
            authorization: `Bearer ${process.env.GITHUB_DISPATCH_TOKEN}`,
            accept: "application/vnd.github+json",
            "content-type": "application/json",
          },
          body: JSON.stringify(result.dispatch),
        });
      }
      return;
    }

    if (classification === "app_mention") {
      const question = stripMention(event.text ?? "", botUserId);
      const threadTs = event.thread_ts ?? event.ts!;
      const isFollowUp = event.thread_ts !== undefined && event.thread_ts !== event.ts;
      const history = isFollowUp
        ? await getThreadReplies(botToken, event.channel!, threadTs, botUserId, event.ts)
        : [];
      await answerInThread(botToken, event.channel!, threadTs, question, history);
      return;
    }

    if (classification === "thread_followup") {
      const threadTs = event.thread_ts!;
      const history = await getThreadReplies(botToken, event.channel!, threadTs, botUserId, event.ts);
      // Only engage in threads the bot actually took part in — a prior assistant turn means the
      // bot answered here before. Otherwise this is just an unrelated threaded conversation.
      if (!history.some((t) => t.role === "assistant")) {
        console.log("thread_followup: bot is not a participant in this thread — ignoring");
        return;
      }
      const question = stripMention(event.text ?? "", botUserId);
      await answerInThread(botToken, event.channel!, threadTs, question, history);
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

// Shared answer flow for both @mentions and untagged thread follow-ups: ack, answer with the
// thread's prior turns as context, post in-thread, and self-heal only on a genuine miss.
async function answerInThread(
  botToken: string,
  channel: string,
  threadTs: string,
  question: string,
  history: Turn[],
): Promise<void> {
  await postMessage({ botToken, channel, text: "Looking that up...", thread_ts: threadTs });

  const result = await answerQuestion(question, history);
  const blocks = buildAnswerBlocks(question, result.text, result.covered);
  await postMessage({ botToken, channel, text: result.text, blocks, thread_ts: threadTs });

  // Only self-heal on a genuine miss — no answer grounded in the KB. If the answer cited a KB
  // source (even while flagging NO_KB_MATCH), don't post the contradictory follow-up.
  if (!result.covered && !hasKbCitation(result.text)) {
    await maybeStartSelfHeal({ question, slackChannel: channel, slackThreadTs: threadTs });
  }
}
