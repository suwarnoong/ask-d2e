import { test } from "node:test";
import assert from "node:assert/strict";
import { routeInteraction, packFixContext, unpackFixContext } from "./slack-interactions.js";

test("thumbs up routes to thanks", () => {
  assert.equal(routeInteraction("feedback_up"), "thanks");
});

test("thumbs down routes to notify-admin regardless of clicker", () => {
  assert.equal(routeInteraction("feedback_down"), "notify-admin");
});

test("admin_fix_confirm routes to admin-confirm", () => {
  assert.equal(routeInteraction("admin_fix_confirm"), "admin-confirm");
});

test("admin_fix_dismiss routes to admin-dismiss", () => {
  assert.equal(routeInteraction("admin_fix_dismiss"), "admin-dismiss");
});

test("unknown action_id routes to ignored", () => {
  assert.equal(routeInteraction("something_else"), "ignored");
});

test("packFixContext/unpackFixContext round-trips", () => {
  const ctx = { repoName: "acme", question: "how does X work?", answer: "X works by...", channelId: "C1", messageTs: "123.456" };
  const packed = packFixContext(ctx);
  assert.deepEqual(unpackFixContext(packed), ctx);
});

test("packFixContext truncates long question/answer well under Slack's button value limit", () => {
  const ctx = { repoName: "acme", question: "q".repeat(5000), answer: "a".repeat(5000), channelId: "C1", messageTs: "123.456" };
  const packed = packFixContext(ctx);
  assert.ok(packed.length < 2000);
});

test("unpackFixContext returns null for malformed JSON", () => {
  assert.equal(unpackFixContext("not json"), null);
});

test("unpackFixContext returns null when required fields are missing", () => {
  assert.equal(unpackFixContext(JSON.stringify({ repoName: "acme" })), null);
});
