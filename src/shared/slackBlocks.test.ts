import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText, toSlackMrkdwn, headerDate } from "./slackBlocks.js";

test("chunkText splits on line boundaries under the limit", () => {
  const text = "line one\n" + "x".repeat(20) + "\n" + "y".repeat(20);
  const chunks = chunkText(text, 25);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.length <= 25);
  assert.equal(chunks.join("\n"), text);
});

test("chunkText hard-splits a single oversized line", () => {
  const text = "z".repeat(60);
  const chunks = chunkText(text, 20);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.length <= 20);
  assert.equal(chunks.join(""), text);
});

test("toSlackMrkdwn converts headings to bold lines", () => {
  assert.equal(toSlackMrkdwn("# Title\nbody"), "*Title*\nbody");
  assert.equal(toSlackMrkdwn("### Sub\nbody"), "*Sub*\nbody");
});

test("toSlackMrkdwn converts bold/strike/link", () => {
  assert.equal(toSlackMrkdwn("**bold**"), "*bold*");
  assert.equal(toSlackMrkdwn("__bold__"), "*bold*");
  assert.equal(toSlackMrkdwn("~~gone~~"), "~gone~");
  assert.equal(toSlackMrkdwn("[text](https://x.com)"), "<https://x.com|text>");
});

test("toSlackMrkdwn leaves fenced code blocks untouched", () => {
  const md = "before\n```js\n# not a heading\n**not bold**\n```\nafter";
  const out = toSlackMrkdwn(md);
  assert.ok(out.includes("```js\n# not a heading\n**not bold**\n```"));
});

test("toSlackMrkdwn protects inline code spans from conversion", () => {
  assert.equal(toSlackMrkdwn("use `**not bold**` here"), "use `**not bold**` here");
});

test("toSlackMrkdwn renders a GFM table as an aligned fenced code block", () => {
  const md = "| A | B |\n|---|---|\n| 1 | 22 |\n";
  const out = toSlackMrkdwn(md);
  assert.ok(out.startsWith("```"));
  assert.ok(out.includes("A"));
  assert.ok(out.includes("22"));
  assert.ok(!out.includes("|---|"));
});

test("headerDate formats with a valid timezone", () => {
  const out = headerDate("2026-09-10T12:00:00Z", "America/New_York");
  assert.match(out, /^\w+, \w{3} \d{1,2}$/);
});

test("headerDate falls back to UTC on an invalid timezone", () => {
  const out = headerDate("2026-09-10T12:00:00Z", "Not/AZone");
  assert.match(out, /^\w+, \w{3} \d{1,2}$/);
});
