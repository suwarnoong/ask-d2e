import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { createHash } from "node:crypto";
import { verifySlackSignature, friendlyError } from "../src/shared/slackAuth.js";
import { chunkText, toSlackMrkdwn, type Block } from "../src/shared/slackBlocks.js";
import { answerQuestion } from "./_lib/answer.js";
import { maybeStartSelfHeal } from "./_lib/selfHeal.js";
import { hasKbCitation } from "../src/kb/repoResolution.js";
import { postMessage } from "./_lib/slackApi.js";
import { readRawBody } from "./_lib/rawBody.js";

export const config = { api: { bodyParser: false } };

const ACK_PHRASES = [
  "Looking that up...",
  "Digging through the knowledge base...",
  "One sec, checking...",
  "On it — searching now...",
];

export function pickAckPhrase(question: string): string {
  const hash = createHash("sha256").update(question).digest();
  const index = hash[0] % ACK_PHRASES.length;
  return ACK_PHRASES[index];
}

export function buildAnswerBlocks(question: string, answerText: string, covered: boolean): Block[] {
  const mrkdwn = toSlackMrkdwn(answerText);
  const chunks = chunkText(mrkdwn);
  const packedValue = question.slice(0, 1900);

  return [
    { type: "section", text: { type: "mrkdwn", text: `*Q: ${question}*` } },
    ...chunks.map((c): Block => ({ type: "section", text: { type: "mrkdwn", text: c } })),
    {
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "👍" }, action_id: "feedback_up", value: packedValue },
        { type: "button", text: { type: "plain_text", text: "👎" }, action_id: "feedback_down", value: packedValue },
      ],
    },
  ];
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
  const question = (params.get("text") ?? "").trim();
  const channelId = params.get("channel_id") ?? "";
  const responseUrl = params.get("response_url") ?? "";

  if (!question) {
    res.status(200).json({ response_type: "ephemeral", text: "Usage: `/ask <your question>`" });
    return;
  }

  // Ephemeral ack (only the asker sees it) satisfies the slash-command 3s deadline; the real
  // answer is posted below.
  res.status(200).json({ response_type: "ephemeral", text: pickAckPhrase(question) });

  // The response above already went out — Vercel doesn't guarantee this invocation stays
  // alive for the async work below unless it's wrapped in waitUntil().
  waitUntil(answerAndRespond(question, channelId, responseUrl));
}

async function answerAndRespond(question: string, channelId: string, responseUrl: string): Promise<void> {
  try {
    const result = await answerQuestion(question);
    const blocks = buildAnswerBlocks(question, result.text, result.covered);

    // Post as a real bot-owned message (chat.postMessage) so the 👍/👎 confirmation can edit it
    // in place, matching the @mention/DM experience. Falls back to response_url if the bot isn't
    // a member of the channel (chat.postMessage → channel_not_found) — there the confirmation is
    // ephemeral instead, but /ask still works everywhere.
    const botToken = process.env.SLACK_BOT_TOKEN!;
    let postedViaBot = false;
    if (channelId) {
      try {
        await postMessage({ botToken, channel: channelId, text: result.text, blocks });
        postedViaBot = true;
      } catch (err) {
        console.log("ask: chat.postMessage failed, falling back to response_url:", friendlyError(err));
      }
    }
    if (!postedViaBot) {
      await fetch(responseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response_type: "in_channel", blocks, text: result.text }),
      });
    }

    // Only self-heal on a genuine miss — see slack-events.ts for the rationale.
    if (!result.covered && !hasKbCitation(result.text)) {
      await maybeStartSelfHeal({ question, respondViaResponseUrl: responseUrl });
    }
  } catch (err) {
    console.error("ask handler error:", err);
    await fetch(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", text: friendlyError(err) }),
    });
  }
}
