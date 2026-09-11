import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopeForSnapshot } from "../../src/kb/kbScope.js";
import { runRetrievalLoop } from "./retrievalLoop.js";
import type { AnthropicLikeClient, AnthropicLikeResponse } from "../../src/shared/anthropicLike.js";

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "loop-"));
  const dir = join(root, "snapshots", "develop", "docs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cli.md"), "# CLI\n\nRun ./d2e up to start the stack.\n");
  return root;
}

/** A client that replays a fixed list of responses and records what it was sent. */
function scriptedClient(responses: AnthropicLikeResponse[]): {
  client: AnthropicLikeClient;
  calls: Record<string, unknown>[];
} {
  const calls: Record<string, unknown>[] = [];
  let i = 0;
  const client: AnthropicLikeClient = {
    messages: {
      create: async (...args: unknown[]) => {
        calls.push(args[0] as Record<string, unknown>);
        if (i >= responses.length) throw new Error(`unexpected call ${i + 1}`);
        return responses[i++];
      },
    },
  };
  return { client, calls };
}

const baseOptions = (root: string) => ({
  model: "test-model",
  maxTokens: 1024,
  system: [{ type: "text", text: "system" }],
  messages: [{ role: "user", content: "how do I start the stack?" }],
  scope: scopeForSnapshot(root, "develop"),
});

test("a question answered without tools returns immediately", async () => {
  const root = makeRoot();
  const { client, calls } = scriptedClient([
    { content: [{ type: "text", text: "Run ./d2e up." }], stop_reason: "end_turn" },
  ]);

  const outcome = await runRetrievalLoop({ client, ...baseOptions(root) });

  assert.equal(outcome.text, "Run ./d2e up.");
  assert.equal(outcome.turns, 1);
  assert.equal(outcome.truncated, false);
  assert.deepEqual(outcome.filesRead, []);
  assert.equal(calls.length, 1);
});

test("a tool_use response is executed and fed back, then the answer is returned", async () => {
  const root = makeRoot();
  const { client, calls } = scriptedClient([
    {
      content: [
        { type: "tool_use", id: "t1", name: "read_kb_file", input: { path: "snapshots/develop/docs/cli.md" } },
      ],
      stop_reason: "tool_use",
    },
    { content: [{ type: "text", text: "Run ./d2e up. (snapshots/develop/docs/cli.md)" }], stop_reason: "end_turn" },
  ]);

  const outcome = await runRetrievalLoop({ client, ...baseOptions(root) });

  assert.match(outcome.text, /d2e up/);
  assert.equal(outcome.turns, 2);
  assert.deepEqual(outcome.filesRead, ["snapshots/develop/docs/cli.md"]);
  assert.ok(outcome.bytesRead > 0);

  const secondCallMessages = (calls[1].messages as { role: string; content: unknown }[]);
  const toolResultTurn = secondCallMessages[secondCallMessages.length - 1];
  assert.equal(toolResultTurn.role, "user");
  const blocks = toolResultTurn.content as { type: string; tool_use_id: string; content: string }[];
  assert.equal(blocks[0].type, "tool_result");
  assert.equal(blocks[0].tool_use_id, "t1");
  assert.match(blocks[0].content, /d2e up/);
});

test("tools are declared to the model on every call", async () => {
  const root = makeRoot();
  const { client, calls } = scriptedClient([
    { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
  ]);

  await runRetrievalLoop({ client, ...baseOptions(root) });

  const tools = calls[0].tools as { name: string }[];
  assert.deepEqual(tools.map((t) => t.name).sort(), ["grep_kb", "list_kb_dir", "read_kb_file"]);
});

test("several tool_use blocks in one response all execute, in order", async () => {
  const root = makeRoot();
  const { client, calls } = scriptedClient([
    {
      content: [
        { type: "tool_use", id: "t1", name: "list_kb_dir", input: { path: "snapshots/develop/docs" } },
        { type: "tool_use", id: "t2", name: "read_kb_file", input: { path: "snapshots/develop/docs/cli.md" } },
      ],
      stop_reason: "tool_use",
    },
    { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
  ]);

  await runRetrievalLoop({ client, ...baseOptions(root) });

  const messages = calls[1].messages as { content: unknown }[];
  const blocks = messages[messages.length - 1].content as { tool_use_id: string }[];
  assert.deepEqual(blocks.map((b) => b.tool_use_id), ["t1", "t2"]);
});

test("a tool error is returned to the model rather than thrown", async () => {
  const root = makeRoot();
  const { client, calls } = scriptedClient([
    {
      content: [{ type: "tool_use", id: "t1", name: "read_kb_file", input: { path: "snapshots/develop/docs/ghost.md" } }],
      stop_reason: "tool_use",
    },
    { content: [{ type: "text", text: "I could not find that." }], stop_reason: "end_turn" },
  ]);

  const outcome = await runRetrievalLoop({ client, ...baseOptions(root) });

  assert.equal(outcome.text, "I could not find that.");
  const messages = calls[1].messages as { content: unknown }[];
  const blocks = messages[messages.length - 1].content as { is_error: boolean; content: string }[];
  assert.equal(blocks[0].is_error, true);
  assert.match(blocks[0].content, /not found/i);
});

test("exceeding maxTurns stops the loop and forces a final toolless answer", async () => {
  const root = makeRoot();
  const toolTurn: AnthropicLikeResponse = {
    content: [{ type: "tool_use", id: "t", name: "read_kb_file", input: { path: "snapshots/develop/docs/cli.md" } }],
    stop_reason: "tool_use",
  };
  const { client, calls } = scriptedClient([
    toolTurn,
    toolTurn,
    { content: [{ type: "text", text: "Partial answer from what I read." }], stop_reason: "end_turn" },
  ]);

  const outcome = await runRetrievalLoop({
    client,
    ...baseOptions(root),
    budget: { maxTurns: 2, maxBytes: 1_000_000 },
  });

  assert.equal(outcome.truncated, true);
  assert.equal(outcome.text, "Partial answer from what I read.");
  // The final call must not offer tools, or the model could keep going.
  assert.equal(calls[calls.length - 1].tools, undefined);
});

test("exceeding maxBytes stops the loop and forces a final toolless answer", async () => {
  const root = makeRoot();
  const toolTurn: AnthropicLikeResponse = {
    content: [{ type: "tool_use", id: "t", name: "read_kb_file", input: { path: "snapshots/develop/docs/cli.md" } }],
    stop_reason: "tool_use",
  };
  const { client } = scriptedClient([
    toolTurn,
    { content: [{ type: "text", text: "Truncated answer." }], stop_reason: "end_turn" },
  ]);

  const outcome = await runRetrievalLoop({
    client,
    ...baseOptions(root),
    budget: { maxTurns: 10, maxBytes: 5 },
  });

  assert.equal(outcome.truncated, true);
  assert.equal(outcome.text, "Truncated answer.");
});

test("filesRead records each distinct file once, in read order", async () => {
  const root = makeRoot();
  const read: AnthropicLikeResponse = {
    content: [{ type: "tool_use", id: "t", name: "read_kb_file", input: { path: "snapshots/develop/docs/cli.md" } }],
    stop_reason: "tool_use",
  };
  const { client } = scriptedClient([
    read,
    read,
    { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
  ]);

  const outcome = await runRetrievalLoop({ client, ...baseOptions(root) });

  assert.deepEqual(outcome.filesRead, ["snapshots/develop/docs/cli.md"]);
});
