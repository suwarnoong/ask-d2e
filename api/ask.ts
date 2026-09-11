import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { verifySlackSignature } from "../src/shared/slackAuth.js";
import { answerInThread } from "./_lib/answerFlow.js";
import { readRawBody } from "./_lib/rawBody.js";

export const config = { api: { bodyParser: false } };

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

  // Empty 200 satisfies the slash-command 3s deadline without a visible response of its own —
  // the shared flow posts the "Looking that up..." ack and answer just like @mention/DM.
  res.status(200).send("");

  // The response above already went out — Vercel doesn't guarantee this invocation stays alive
  // for the async work below unless it's wrapped in waitUntil().
  waitUntil(
    answerInThread({ botToken: process.env.SLACK_BOT_TOKEN!, channel: channelId, question, history: [], responseUrlFallback: responseUrl }),
  );
}
