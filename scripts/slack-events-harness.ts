/**
 * Local Slack EVENTS harness — drives the real api/slack-events.ts handler in-process with a
 * synthetic event, stubbing every outbound call (Slack Web API + Anthropic), and prints what
 * the bot would do. No deploy, no network, no real Slack/Anthropic.
 *
 * Run:  npm run harness:events
 *
 * Proves the NEW thread-follow-up logic: classification, the "did the bot participate in this
 * thread" gate, thread-history assembly, and in-thread posting. It does NOT prove that Slack
 * actually delivers an untagged message.channels event to us — that depends on the event
 * subscription config and only a deploy (or a tunnel) can confirm it.
 */
import { Readable } from "node:stream";
import { createHmac } from "node:crypto";

const SIGNING_SECRET = "harness-signing-secret";
process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
process.env.SLACK_BOT_TOKEN = "xoxb-harness";
process.env.ANTHROPIC_API_KEY = "sk-ant-harness";
process.env.KB_FEEDBACK_ADMIN_IDS = "UADMIN";

const BOT_USER = "UBOT";
const CANNED_ANSWER = "TrexSQL is the DuckDB-based analytics cache. Source: repos/data2evidence/knowledge-base/03/trexsql.md";

const { default: eventsHandler } = await import("../api/slack-events.js");

type Captured = { url: string; method: string; body: unknown };

// `thread` = the conversations.replies the stub returns (controls the participation gate).
function installStub(thread: Array<{ user?: string; bot_id?: string; text: string; ts: string }>) {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const u = String(url);
    let body: unknown = init.body;
    try {
      body = JSON.parse(init.body as string);
    } catch {
      /* leave raw */
    }
    calls.push({ url: u, method: (init.method as string) ?? "GET", body });

    const json = (obj: unknown) =>
      ({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => obj, text: async () => JSON.stringify(obj) }) as unknown as Response;

    if (u.includes("slack.com/api/auth.test")) return json({ ok: true, user_id: BOT_USER });
    if (u.includes("slack.com/api/conversations.replies")) return json({ ok: true, messages: thread });
    // conversations.history is newest-first in real Slack; return reversed so the harness mirrors it.
    if (u.includes("slack.com/api/conversations.history")) return json({ ok: true, messages: [...thread].reverse() });
    if (u.includes("slack.com/api/")) return json({ ok: true, ts: "1700000000.000900" });
    if (u.includes("api.anthropic.com")) {
      return json({
        id: "msg_harness",
        type: "message",
        role: "assistant",
        model: "claude-harness",
        content: [{ type: "text", text: CANNED_ANSWER }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }
    return json({ ok: true });
  }) as typeof fetch;

  return { calls, restore: () => { globalThis.fetch = original; } };
}

function signedReq(payloadObj: unknown) {
  const raw = JSON.stringify(payloadObj);
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = "v0=" + createHmac("sha256", SIGNING_SECRET).update(`v0:${ts}:${raw}`).digest("hex");
  const req = Readable.from([Buffer.from(raw)]) as unknown as { headers: Record<string, string>; method: string };
  req.headers = { "x-slack-signature": sig, "x-slack-request-timestamp": ts };
  req.method = "POST";
  return req;
}

function fakeRes() {
  const res = {
    status() { return res; },
    send() { return res; },
    json() { return res; },
    setHeader() { return res; },
    end() { return res; },
  };
  return res;
}

async function waitForQuiet(calls: Captured[], quietMs = 200, maxMs = 5000) {
  const start = Date.now();
  let lastLen = -1;
  let lastChange = Date.now();
  while (Date.now() - start < maxMs) {
    if (calls.length !== lastLen) { lastLen = calls.length; lastChange = Date.now(); }
    else if (Date.now() - lastChange >= quietMs) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

function summarize(c: Captured): string {
  if (c.url.includes("api.anthropic.com")) return "Anthropic messages.create (answer generated)";
  const m = c.url.match(/slack\.com\/api\/([\w.]+)/);
  if (m) {
    const b = c.body as Record<string, any>;
    if (m[1] === "chat.postMessage") return `Slack chat.postMessage  thread_ts=${b?.thread_ts}  text="${String(b?.text ?? "").slice(0, 55)}"`;
    return `Slack ${m[1]}`;
  }
  return `POST ${c.url}`;
}

async function scenario(name: string, event: unknown, thread: Array<{ user?: string; bot_id?: string; text: string; ts: string }>) {
  const { calls, restore } = installStub(thread);
  try {
    await eventsHandler(signedReq({ type: "event_callback", event }) as any, fakeRes() as any);
    await waitForQuiet(calls);
  } finally {
    restore();
  }
  console.log(`\n=== ${name} ===`);
  if (calls.length === 0) console.log("  (no outbound calls — event ignored)");
  for (const c of calls) console.log("  → " + summarize(c));
}

async function main() {
  // Thread where the bot already answered (has a bot turn) → follow-up should be answered.
  const threadWithBot = [
    { user: "U1", text: "<@UBOT> what is trex?", ts: "1" },
    { bot_id: "B1", text: "Trex is the runtime engine...", ts: "2" },
    { user: "U1", text: "and the caching layer?", ts: "5" }, // the follow-up (current msg)
  ];
  // Thread the bot never spoke in → untagged reply should be ignored.
  const threadNoBot = [
    { user: "U1", text: "hey team", ts: "1" },
    { user: "U2", text: "what about caching?", ts: "5" },
  ];

  // threadWithBot's root message is authored by U1, so U1 is the thread owner.
  const ownerFollowUp = { type: "message", channel_type: "channel", user: "U1", channel: "C1", text: "and the caching layer?", ts: "5", thread_ts: "1" };
  const strangerFollowUp = { type: "message", channel_type: "channel", user: "U2", channel: "C1", text: "and the caching layer?", ts: "5", thread_ts: "1" };

  await scenario("untagged follow-up from the THREAD OWNER → answers in thread", ownerFollowUp, threadWithBot);
  await scenario("untagged reply from a NON-OWNER → ignored (they must @mention)", strangerFollowUp, threadWithBot);
  await scenario(
    "owner replies but @mentions ANOTHER person (not the bot) → ignored",
    { type: "message", channel_type: "channel", user: "U1", channel: "C1", text: "<@UBOB> can you check this?", ts: "5", thread_ts: "1" },
    threadWithBot,
  );
  await scenario("untagged thread reply, bot NOT a participant → ignored", ownerFollowUp, threadNoBot);
  await scenario(
    "top-level channel message (not a thread) → ignored",
    { type: "message", channel_type: "channel", user: "U1", channel: "C1", text: "random chatter", ts: "5" },
    threadNoBot,
  );
  await scenario(
    "bot's own message echoed back → ignored (loop guard)",
    { type: "message", channel_type: "channel", bot_id: "B1", channel: "C1", text: "Trex is...", ts: "6", thread_ts: "1" },
    threadWithBot,
  );
  // DM: a plain message with no @mention should be answered directly (no thread).
  await scenario(
    "DM to the bot (no @mention needed) → answers directly",
    { type: "message", channel_type: "im", user: "U1", channel: "D1", text: "what is trex?", ts: "9" },
    [
      { user: "U1", text: "hi", ts: "7" },
      { bot_id: "B1", text: "Hello!", ts: "8" },
      { user: "U1", text: "what is trex?", ts: "9" },
    ],
  );
}

await main();
