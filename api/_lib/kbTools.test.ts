import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopeForSnapshot } from "../../src/kb/kbScope.js";
import { KB_TOOL_DEFS, executeKbTool } from "./kbTools.js";

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kbtools-"));
  const docs = join(root, "snapshots", "develop", "docs", "setup");
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "cli.md"), "# CLI\n\nRun `./d2e up` to start.\n");
  writeFileSync(join(docs, "tls.md"), "# TLS\n\nCertificates live in ssl/.\n");
  const other = join(root, "snapshots", "v0.17.1-beta", "docs");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "old.md"), "# Old\n\nSecret older content.\n");
  return root;
}

test("KB_TOOL_DEFS declares exactly the three retrieval tools", () => {
  assert.deepEqual(KB_TOOL_DEFS.map((t) => t.name).sort(), [
    "grep_kb",
    "list_kb_dir",
    "read_kb_file",
  ]);
  for (const def of KB_TOOL_DEFS) {
    assert.equal(def.input_schema.type, "object");
    assert.ok(def.description.length > 20, `${def.name} needs a usable description`);
  }
});

test("read_kb_file returns file contents and byte count", () => {
  const scope = scopeForSnapshot(makeRoot(), "develop");
  const result = executeKbTool("read_kb_file", { path: "snapshots/develop/docs/setup/cli.md" }, scope);

  assert.equal(result.isError, false);
  assert.match(result.content, /Run `\.\/d2e up` to start\./);
  assert.equal(result.bytes, result.content.length);
});

test("read_kb_file reports a missing file as a recoverable tool error", () => {
  const scope = scopeForSnapshot(makeRoot(), "develop");
  const result = executeKbTool("read_kb_file", { path: "snapshots/develop/docs/nope.md" }, scope);

  assert.equal(result.isError, true);
  assert.match(result.content, /not found/i);
});

test("read_kb_file refuses a path in another snapshot", () => {
  const scope = scopeForSnapshot(makeRoot(), "develop");
  const result = executeKbTool(
    "read_kb_file",
    { path: "snapshots/v0.17.1-beta/docs/old.md" },
    scope,
  );

  assert.equal(result.isError, true);
  assert.match(result.content, /scope/i);
  assert.doesNotMatch(result.content, /Secret older content/);
});

test("read_kb_file rejects a missing or non-string path argument", () => {
  const scope = scopeForSnapshot(makeRoot(), "develop");
  assert.equal(executeKbTool("read_kb_file", {}, scope).isError, true);
  assert.equal(executeKbTool("read_kb_file", { path: 42 }, scope).isError, true);
});

test("grep_kb finds matches with their file and line number", () => {
  const scope = scopeForSnapshot(makeRoot(), "develop");
  const result = executeKbTool("grep_kb", { pattern: "d2e up" }, scope);

  assert.equal(result.isError, false);
  assert.match(result.content, /snapshots\/develop\/docs\/setup\/cli\.md:3/);
});

test("grep_kb never reaches outside the scope", () => {
  const scope = scopeForSnapshot(makeRoot(), "develop");
  const result = executeKbTool("grep_kb", { pattern: "Secret older content" }, scope);

  assert.equal(result.isError, false);
  assert.match(result.content, /no matches/i);
});

test("grep_kb reports an invalid regex as a tool error", () => {
  const scope = scopeForSnapshot(makeRoot(), "develop");
  const result = executeKbTool("grep_kb", { pattern: "unclosed(" }, scope);

  assert.equal(result.isError, true);
  assert.match(result.content, /invalid/i);
});

test("grep_kb rejects an overlong pattern", () => {
  const scope = scopeForSnapshot(makeRoot(), "develop");
  const result = executeKbTool("grep_kb", { pattern: "a".repeat(201) }, scope);

  assert.equal(result.isError, true);
  assert.match(result.content, /too long/i);
});

test("list_kb_dir lists entries, marking directories", () => {
  const scope = scopeForSnapshot(makeRoot(), "develop");
  const result = executeKbTool("list_kb_dir", { path: "snapshots/develop/docs" }, scope);

  assert.equal(result.isError, false);
  assert.match(result.content, /setup\/$/m);
});

test("an unknown tool name is a recoverable error", () => {
  const scope = scopeForSnapshot(makeRoot(), "develop");
  const result = executeKbTool("rm_rf", { path: "/" }, scope);

  assert.equal(result.isError, true);
  assert.match(result.content, /unknown tool/i);
});
