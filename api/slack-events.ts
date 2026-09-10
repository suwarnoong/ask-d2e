import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { verifySlackSignature, isAdmin } from "../src/shared/slackAuth.js";
import { getThreadReplies, getDmHistory, getBotUserId, postMessage, stripMention } from "./_lib/slackApi.js";
import { applyWizardTurn } from "../src/admin/wizard/addRepoWizard.js";
import { answerQuestion } from "./_lib/answer.js";
import { buildAnswerBlocks } from "./ask.js";
import { maybeStartSelfHeal } from "./_lib/selfHeal.js";
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
    user?: string;
    channel?: string;
    channel_type?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
  };
}

export type EventClassification = "url_verification" | "retry" | "self" | "wizard_turn" | "app_mention" | "ignored";

export function classifyEvent(payload: SlackEventPayload, botUserId: string, isRetry: boolean): EventClassification {
  if (payload.type === "url_verification") return "url_verification";
  if (isRetry) return "retry";

  const event = payload.event;
  if (!event) return "ignored";
  if (event.user === botUserId) return "self";
  if (event.type === "message" && event.channel_type === "im") return "wizard_turn";
  if (event.type === "app_mention") return "app_mention";
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

      await postMessage({ botToken, channel: event.channel!, text: "Looking that up...", thread_ts: threadTs });

      const result = await answerQuestion(question, history);
      const blocks = buildAnswerBlocks(question, result.text, result.covered);
      await postMessage({ botToken, channel: event.channel!, text: result.text, blocks, thread_ts: threadTs });

      if (!result.covered) {
        await maybeStartSelfHeal({ question, slackChannel: event.channel!, slackThreadTs: threadTs });
      }
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
