import { test } from "node:test";
import assert from "node:assert/strict";
import { routeInteraction, packFixContext, unpackFixContext, buildConfirmationBlocks } from "./slack-interactions.js";
import type { Block } from "../src/shared/slackBlocks.js";

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

const sampleBlocks: Block[] = [
  { type: "section", text: { type: "mrkdwn", text: "*Q: what is d2e?*" } },
  { type: "section", text: { type: "mrkdwn", text: "d2e is..." } },
  { type: "actions", elements: [{ type: "button" }] },
];

test("buildConfirmationBlocks strips the actions block and appends a context confirmation", () => {
  const result = buildConfirmationBlocks(sampleBlocks, "✅ Thanks for the feedback!");
  assert.equal(result.some((b) => b.type === "actions"), false);
  assert.deepEqual(result.at(-1), {
    type: "context",
    elements: [{ type: "mrkdwn", text: "✅ Thanks for the feedback!" }],
  });
});

test("buildConfirmationBlocks preserves the original non-actions blocks unchanged", () => {
  const result = buildConfirmationBlocks(sampleBlocks, "Dismissed.");
  assert.equal(result.length, 3);
  assert.equal(result[0], sampleBlocks[0]);
  assert.equal(result[1], sampleBlocks[1]);
});
