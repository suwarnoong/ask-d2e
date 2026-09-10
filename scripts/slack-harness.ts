/**
 * Local Slack interaction harness — exercise the real api/slack-interactions.ts handler
 * offline, with a stubbed outbound `fetch`, and print exactly what the bot WOULD send to
 * Slack. No deploy, no network, no real Slack workspace.
 *
 * Run:  npm run harness
 *
 * What it CAN test: routing, confirmClick's chat.update-vs-ephemeral choice and its fallback,
 * the 👎 → admin-DM flow, admin confirm/dismiss, self-heal gating — i.e. all the wiring/logic.
 * What it CANNOT test: real Slack server-side behavior (whether chat.update actually succeeds
 * on a given message, ephemeral rendering, etc.) — those need a real Slack round-trip. The
 * harness lets you INJECT Slack responses (e.g. a cant_update_message error) to verify how our
 * code reacts, which is the next best thing.
 */
import { Readable } from "node:stream";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SIGNING_SECRET = "harness-signing-secret";

// Env must be set BEFORE importing the handler (some values are read at module load).
process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
process.env.SLACK_BOT_TOKEN = "xoxb-harness";
process.env.KB_FEEDBACK_ADMIN_IDS = "UADMIN";
process.env.GITHUB_DISPATCH_TOKEN = "ghp-harness";

// Minimal offline KB so loadRegistry() works without the bundled knowledge-base/.
const kbRoot = mkdtempSync(join(tmpdir(), "harness-kb-"));
mkdirSync(join(kbRoot, "repos", "data2evidence", "knowledge-base"), { recursive: true });
writeFileSync(
  join(kbRoot, "repos.json"),
  JSON.stringify(
    [
      {
        name: "data2evidence",
        sourceRepo: "OHDSI/Data2Evidence",
        promptSpec: { audience: "eng", exampleQuestions: [], focusAreas: [], scopeNotes: "" },
        cadence: "weekly",
        status: "active",
        createdBy: "U1",
        createdAt: "2026-01-01T00:00:00Z",
        lastRefreshedAt: null,
        lastAutoRefreshAt: null,
      },
    ],
    null,
    2,
  ) + "\n",
);
process.env.KB_ROOT = kbRoot;

const { default: interactionsHandler } = await import("../api/slack-interactions.js");

type Captured = { url: string; method: string; body: unknown };

// A fetch stub: records every outbound call, and returns responses based on a per-Slack-method
// override map so scenarios can inject errors like cant_update_message.
function installFetchStub(slackOverrides: Record<string, { ok: boolean; error?: string; ts?: string }>) {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const u = String(url);
    let body: unknown = init.body;
    try {
      body = JSON.parse(init.body as string);
    } catch {
      /* response_url form posts / non-JSON — leave raw */
    }
    calls.push({ url: u, method: (init.method as string) ?? "GET", body });

    // Slack Web API (chat.postMessage, chat.update, conversations.open, ...)
    const m = u.match(/slack\.com\/api\/([\w.]+)/);
    if (m) {
      const method = m[1];
      const override = slackOverrides[method];
      const json = override ?? { ok: true, ts: "1700000000.000100", channel: { id: "D_ADMIN" } };
      return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) } as unknown as Response;
    }
    // response_url posts and GitHub dispatch — bodies aren't read by our code
    return { ok: true, status: 200, json: async () => ({}), text: async () => "ok" } as unknown as Response;
  }) as typeof fetch;

  return { calls, restore: () => { globalThis.fetch = original; } };
}

function signedReq(payloadObj: unknown) {
  const raw = "payload=" + encodeURIComponent(JSON.stringify(payloadObj));
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = "v0=" + createHmac("sha256", SIGNING_SECRET).update(`v0:${ts}:${raw}`).digest("hex");
  const req = Readable.from([Buffer.from(raw)]) as unknown as {
    headers: Record<string, string>;
    method: string;
  };
  req.headers = { "x-slack-signature": sig, "x-slack-request-timestamp": ts };
  req.method = "POST";
  return req;
}

function fakeRes() {
  const res = {
    _status: 0,
    _payload: undefined as unknown,
    status(code: number) { res._status = code; return res; },
    send(body?: unknown) { res._payload = body; return res; },
    json(obj: unknown) { res._payload = obj; return res; },
    setHeader() { return res; },
    end() { return res; },
  };
  return res;
}

// Wait for background waitUntil() work to settle — poll until no new outbound calls for a bit.
async function waitForQuiet(calls: Captured[], quietMs = 150, maxMs = 4000) {
  const start = Date.now();
  let lastLen = -1;
  let lastChange = Date.now();
  while (Date.now() - start < maxMs) {
    if (calls.length !== lastLen) { lastLen = calls.length; lastChange = Date.now(); }
    else if (Date.now() - lastChange >= quietMs) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

function summarize(c: Captured): string {
  const m = c.url.match(/slack\.com\/api\/([\w.]+)/);
  if (m) {
    const b = c.body as Record<string, any>;
    const method = m[1];
    if (method === "chat.update" || method === "chat.postMessage") {
      const blockTypes = Array.isArray(b?.blocks) ? b.blocks.map((x: any) => x.type).join(",") : "none";
      return `Slack ${method}  channel=${b?.channel}  text="${String(b?.text ?? "").slice(0, 60)}"  blocks=[${blockTypes}]`;
    }
    return `Slack ${method}  ${JSON.stringify(b).slice(0, 120)}`;
  }
  if (c.url.includes("api.github.com")) return `GitHub workflow_dispatch  ${JSON.stringify((c.body as any)?.inputs ?? {}).slice(0, 140)}`;
  return `response_url POST  ${JSON.stringify(c.body).slice(0, 140)}`;
}

async function scenario(name: string, payloadObj: unknown, slackOverrides: Record<string, any> = {}) {
  const { calls, restore } = installFetchStub(slackOverrides);
  try {
    await interactionsHandler(signedReq(payloadObj) as any, fakeRes() as any);
    await waitForQuiet(calls);
  } finally {
    restore();
  }
  console.log(`\n=== ${name} ===`);
  if (calls.length === 0) console.log("  (no outbound calls)");
  for (const c of calls) console.log("  → " + summarize(c));
}

// --- payload builders ---
const answerBlocks = (answerText: string) => [
  { type: "section", text: { type: "mrkdwn", text: "*Q: what is trex?*" } },
  { type: "section", text: { type: "mrkdwn", text: answerText } },
  { type: "actions", elements: [{ type: "button", action_id: "feedback_up", text: { type: "plain_text", text: "👍" }, value: "what is trex?" }] },
];

const clickPayload = (opts: { actionId: string; user: string; value?: string; withMessage: boolean; answerText?: string }) => ({
  type: "block_actions",
  user: { id: opts.user },
  channel: { id: "C_TEST" },
  response_url: "https://hooks.slack.com/actions/HARNESS/response_url",
  actions: [{ action_id: opts.actionId, value: opts.value ?? "what is trex?" }],
  ...(opts.withMessage
    ? { message: { ts: "1700000000.000001", blocks: answerBlocks(opts.answerText ?? "Trex is D2E's runtime engine. Source: repos/data2evidence/knowledge-base/01/core.md") } }
    : {}),
});

async function main() {
  // 1. 👍 on a bot-owned message → chat.update replaces buttons with a confirmation context block.
  await scenario("thumbs-up on bot-owned message (@mention answer)", clickPayload({ actionId: "feedback_up", user: "U1", withMessage: true }));

  // 2. 👍 but chat.update is rejected (the /ask-in-channel case) → falls back to ephemeral.
  await scenario(
    "thumbs-up, chat.update rejected (cant_update_message) → ephemeral fallback",
    clickPayload({ actionId: "feedback_up", user: "U1", withMessage: true }),
    { "chat.update": { ok: false, error: "cant_update_message" } },
  );

  // 3. 👍 with NO message in payload (/ask in a DM) → ephemeral directly.
  await scenario("thumbs-up, no payload.message (/ask in DM)", clickPayload({ actionId: "feedback_up", user: "U1", withMessage: false }));

  // 4. 👎 on a bot-owned, KB-cited answer → confirmation + admin DM with Refresh/Dismiss.
  await scenario("thumbs-down on grounded answer → admin DM with buttons", clickPayload({ actionId: "feedback_down", user: "U1", withMessage: true }));

  // 5. admin clicks "Refresh KB & Answer" → GitHub dispatch + confirmation.
  const ctx = JSON.stringify({ repoName: "data2evidence", question: "what is trex?", answer: "Trex is...", channelId: "C_TEST", messageTs: "1700000000.000001" });
  await scenario("admin confirm (Refresh KB & Answer)", clickPayload({ actionId: "admin_fix_confirm", user: "UADMIN", value: ctx, withMessage: true }));

  // 6. non-admin somehow hits the confirm action → refused.
  await scenario("non-admin hits confirm → refused", clickPayload({ actionId: "admin_fix_confirm", user: "U1", value: ctx, withMessage: true }));

  console.log("\nDone. (KB temp dir: " + kbRoot + ")");
}

await main();
