import { test, before } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseClaudeCliOutput, callClaude } from "./claude.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "__fixtures__", "fake-claude.mjs");

before(() => {
  chmodSync(fixturePath, 0o755);
});

test("parseClaudeCliOutput extracts .result from valid JSON", () => {
  assert.equal(parseClaudeCliOutput('{"result":"hello"}'), "hello");
});

test("parseClaudeCliOutput throws on unparseable output", () => {
  assert.throws(() => parseClaudeCliOutput("not json"), /unparseable output/);
});

test("parseClaudeCliOutput throws when .result is missing", () => {
  assert.throws(() => parseClaudeCliOutput('{"ok":true}'), /missing a non-empty "result"/);
});

test("parseClaudeCliOutput throws when .result is empty", () => {
  assert.throws(() => parseClaudeCliOutput('{"result":"  "}'), /missing a non-empty "result"/);
});

test("callClaude rejects when the auth token is missing", async () => {
  await assert.rejects(
    () => callClaude("prompt", { claudeOauthToken: "", claudeModel: "m" }),
    /Missing CLAUDE_CODE_OAUTH_TOKEN/,
  );
});

test("callClaude resolves with the echoed result on success", async () => {
  const prevMode = process.env.FAKE_CLAUDE_MODE;
  process.env.FAKE_CLAUDE_MODE = "success";
  try {
    const result = await callClaude("hello prompt", { claudeOauthToken: "tok", claudeModel: "m" }, { spawnCmd: fixturePath });
    assert.equal(result, "echo:hello prompt");
  } finally {
    if (prevMode === undefined) delete process.env.FAKE_CLAUDE_MODE;
    else process.env.FAKE_CLAUDE_MODE = prevMode;
  }
});

test("callClaude rejects on non-zero exit", async () => {
  process.env.FAKE_CLAUDE_MODE = "nonzero";
  await assert.rejects(
    () => callClaude("p", { claudeOauthToken: "tok", claudeModel: "m" }, { spawnCmd: fixturePath }),
    /exited with code 1/,
  );
  delete process.env.FAKE_CLAUDE_MODE;
});

test("callClaude rejects on bad JSON output", async () => {
  process.env.FAKE_CLAUDE_MODE = "badjson";
  await assert.rejects(
    () => callClaude("p", { claudeOauthToken: "tok", claudeModel: "m" }, { spawnCmd: fixturePath }),
    /unparseable output/,
  );
  delete process.env.FAKE_CLAUDE_MODE;
});

test("callClaude times out and kills a hanging process", async () => {
  process.env.FAKE_CLAUDE_MODE = "hang";
  process.env.CLAUDE_TIMEOUT_MS = "200";
  await assert.rejects(
    () => callClaude("p", { claudeOauthToken: "tok", claudeModel: "m" }, { spawnCmd: fixturePath }),
    /timed out after 200ms/,
  );
  delete process.env.FAKE_CLAUDE_MODE;
  delete process.env.CLAUDE_TIMEOUT_MS;
});
