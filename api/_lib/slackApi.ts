export interface Turn {
  role: "user" | "assistant";
  text: string;
}

export interface SlackHistoryMessage {
  ts: string;
  text: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
}

export function stripMention(text: string, botUserId?: string): string {
  const pattern = botUserId ? new RegExp(`<@${botUserId}>\\s*`, "g") : /<@[A-Z0-9]+>\s*/g;
  return text.replace(pattern, "").trim();
}

export function mapHistoryToTurns(
  messages: SlackHistoryMessage[],
  botUserId: string | undefined,
  excludeTs?: string,
): Turn[] {
  const turns: Turn[] = [];
  for (const msg of messages) {
    if (excludeTs && msg.ts === excludeTs) continue;
    if (msg.subtype) continue;
    const isBot = Boolean(msg.bot_id) || (botUserId !== undefined && msg.user === botUserId);
    if (isBot) {
      turns.push({ role: "assistant", text: msg.text });
    } else {
      turns.push({ role: "user", text: stripMention(msg.text, botUserId) });
    }
  }
  return turns;
}

// JSON body — for "write" methods (chat.postMessage/update, reactions, conversations.open)
// where nested fields like `blocks` must be real JSON objects.
async function slackApiCall<T>(
  method: string,
  botToken: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!data.ok) throw new Error(`Slack API ${method} failed: ${data.error}`);
  return data;
}

// Form-encoded — for "read" methods like conversations.history/replies, which IGNORE a JSON
// body (they only read args from the query string / form body) and otherwise fail with
// invalid_arguments "missing required field".
async function slackApiForm<T>(
  method: string,
  botToken: string,
  params: Record<string, string | number>,
): Promise<T> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) form.set(k, String(v));
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      authorization: `Bearer ${botToken}`,
    },
    body: form.toString(),
  });
  const data = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!data.ok) throw new Error(`Slack API ${method} failed: ${data.error}`);
  return data;
}

export async function postMessage(opts: {
  botToken: string;
  channel: string;
  text: string;
  blocks?: unknown[];
  thread_ts?: string;
}): Promise<void> {
  await slackApiCall("chat.postMessage", opts.botToken, {
    channel: opts.channel,
    text: opts.text,
    blocks: opts.blocks,
    thread_ts: opts.thread_ts,
    as_user: true,
  });
}

export async function updateMessage(opts: {
  botToken: string;
  channel: string;
  ts: string;
  text: string;
  blocks?: unknown[];
}): Promise<void> {
  await slackApiCall("chat.update", opts.botToken, {
    channel: opts.channel,
    ts: opts.ts,
    text: opts.text,
    blocks: opts.blocks,
    as_user: true,
  });
}

export async function openDm(botToken: string, userId: string): Promise<string> {
  const data = await slackApiCall<{ channel: { id: string } }>("conversations.open", botToken, {
    users: userId,
  });
  return data.channel.id;
}

export async function getThreadReplies(
  botToken: string,
  channel: string,
  thread_ts: string,
  botUserId?: string,
  excludeTs?: string,
): Promise<Turn[]> {
  const data = await slackApiForm<{ messages: SlackHistoryMessage[] }>("conversations.replies", botToken, {
    channel,
    ts: thread_ts,
    limit: 50,
  });
  return mapHistoryToTurns(data.messages, botUserId, excludeTs);
}

export async function getDmHistory(botToken: string, channel: string, limit = 20): Promise<SlackHistoryMessage[]> {
  const data = await slackApiForm<{ messages: SlackHistoryMessage[] }>("conversations.history", botToken, {
    channel,
    limit,
  });
  return data.messages;
}

let cachedBotUserId: string | undefined;

export async function getBotUserId(botToken: string): Promise<string> {
  if (cachedBotUserId) return cachedBotUserId;
  const data = await slackApiCall<{ user_id: string }>("auth.test", botToken, {});
  cachedBotUserId = data.user_id;
  return cachedBotUserId;
}
