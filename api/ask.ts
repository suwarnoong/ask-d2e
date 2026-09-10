import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHash } from "node:crypto";
import { verifySlackSignature, friendlyError } from "../src/shared/slackAuth.js";
import { chunkText, toSlackMrkdwn, type Block } from "../src/shared/slackBlocks.js";
import { answerQuestion } from "./_lib/answer.js";
import { maybeStartSelfHeal } from "./_lib/selfHeal.js";

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
  const rawBody = typeof req.body === "string" ? req.body : new URLSearchParams(req.body as Record<string, string>).toString();
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
  const responseUrl = params.get("response_url") ?? "";

  if (!question) {
    res.status(200).json({ response_type: "ephemeral", text: "Usage: `/ask <your question>`" });
    return;
  }

  res.status(200).json({ response_type: "ephemeral", text: pickAckPhrase(question) });

  try {
    const result = await answerQuestion(question);
    const blocks = buildAnswerBlocks(question, result.text, result.covered);
    await fetch(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_type: "in_channel", blocks, text: result.text }),
    });
    if (!result.covered) {
      await maybeStartSelfHeal({ question, respondViaResponseUrl: responseUrl });
    }
  } catch (err) {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", text: friendlyError(err) }),
    });
  }
}
