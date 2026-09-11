import { chunkText, toSlackMrkdwn, type Block } from "../../src/shared/slackBlocks.js";
import { hasKbCitation } from "../../src/kb/repoResolution.js";
import { answerQuestion } from "./answer.js";
import { maybeStartSelfHeal } from "./selfHeal.js";
import { postMessage, type Turn } from "./slackApi.js";

// The one place answer messages are built — shared by @mention, DM, thread follow-up, and /ask
// so all four render identically (question header, chunked answer, 👍/👎 buttons).
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

export interface AnswerFlowArgs {
  botToken: string;
  channel: string;
  question: string;
  history: Turn[];
  // Existing thread to reply in (an @mention's thread, or a DM message). Undefined for /ask,
  // which has no parent message — the "Looking that up..." ack becomes the thread parent instead.
  parentThreadTs?: string;
  // /ask only: if the bot isn't a member of the channel, chat.postMessage fails, so deliver via
  // response_url instead (which works regardless of membership). @mention/DM never need this.
  responseUrlFallback?: string;
}

// The single shared answer flow for every entry point: post a "Looking that up..." ack, generate
// the answer, post it (as a real bot-owned message so 👍/👎 can be confirmed in place), and
// self-heal only on a genuine, uncited miss.
export async function answerInThread(args: AnswerFlowArgs): Promise<void> {
  const { botToken, channel, question, history, parentThreadTs, responseUrlFallback } = args;

  let ackTs: string;
  try {
    ackTs = await postMessage({ botToken, channel, text: "Looking that up...", thread_ts: parentThreadTs });
  } catch (err) {
    // Bot isn't in the channel (chat.postMessage → channel_not_found). /ask can still deliver
    // via response_url; other entry points can't reach here (they require channel membership).
    if (!responseUrlFallback) throw err;
    const result = await answerQuestion(question, history);
    const blocks = buildAnswerBlocks(question, result.text, result.covered);
    await fetch(responseUrlFallback, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_type: "in_channel", blocks, text: result.text }),
    });
    if (!result.covered && !hasKbCitation(result.text)) {
      await maybeStartSelfHeal({ question, respondViaResponseUrl: responseUrlFallback });
    }
    return;
  }

  // Reply in the existing thread if there is one; otherwise thread the answer under our ack.
  const threadTs = parentThreadTs ?? ackTs;
  const result = await answerQuestion(question, history);
  const blocks = buildAnswerBlocks(question, result.text, result.covered);
  await postMessage({ botToken, channel, text: result.text, blocks, thread_ts: threadTs });

  if (!result.covered && !hasKbCitation(result.text)) {
    await maybeStartSelfHeal({ question, slackChannel: channel, slackThreadTs: threadTs });
  }
}
