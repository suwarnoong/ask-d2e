import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEvent, type SlackEventPayload } from "./slack-events.js";

const BOT = "UBOT";

test("classifies url_verification", () => {
  const payload = { type: "url_verification", challenge: "abc" } as SlackEventPayload;
  assert.equal(classifyEvent(payload, BOT, false), "url_verification");
});

test("classifies a retried event as retry regardless of content", () => {
  const payload = { type: "event_callback", event: { type: "app_mention", user: "U1", channel: "C1", text: "hi", ts: "1" } } as SlackEventPayload;
  assert.equal(classifyEvent(payload, BOT, true), "retry");
});

test("classifies an event from the bot itself as self", () => {
  const payload = { type: "event_callback", event: { type: "message", user: BOT, channel: "C1", text: "hi", ts: "1", channel_type: "im" } } as SlackEventPayload;
  assert.equal(classifyEvent(payload, BOT, false), "self");
});

test("classifies a DM message as a direct question (no @mention needed)", () => {
  const payload = { type: "event_callback", event: { type: "message", user: "U1", channel: "D1", text: "what is trex?", ts: "1", channel_type: "im" } } as SlackEventPayload;
  assert.equal(classifyEvent(payload, BOT, false), "dm_question");
});

test("classifies an app_mention as app_mention, not colliding with the DM branch", () => {
  const payload = { type: "event_callback", event: { type: "app_mention", user: "U1", channel: "C1", text: `<@${BOT}> hi`, ts: "1" } } as SlackEventPayload;
  assert.equal(classifyEvent(payload, BOT, false), "app_mention");
});

test("classifies anything else as ignored", () => {
  const payload = { type: "event_callback", event: { type: "reaction_added" } } as unknown as SlackEventPayload;
  assert.equal(classifyEvent(payload, BOT, false), "ignored");
});

test("classifies an untagged threaded channel reply as thread_followup", () => {
  const payload = { type: "event_callback", event: { type: "message", user: "U1", channel: "C1", channel_type: "channel", text: "and what about caching?", ts: "5", thread_ts: "1" } } as SlackEventPayload;
  assert.equal(classifyEvent(payload, BOT, false), "thread_followup");
});

test("a top-level (non-threaded) channel message is ignored, not a follow-up", () => {
  const payload = { type: "event_callback", event: { type: "message", user: "U1", channel: "C1", channel_type: "channel", text: "random chatter", ts: "5" } } as SlackEventPayload;
  assert.equal(classifyEvent(payload, BOT, false), "ignored");
});

test("a threaded reply that @mentions the bot is left to the app_mention event (ignored here)", () => {
  const payload = { type: "event_callback", event: { type: "message", user: "U1", channel: "C1", channel_type: "channel", text: `<@${BOT}> follow up`, ts: "5", thread_ts: "1" } } as SlackEventPayload;
  assert.equal(classifyEvent(payload, BOT, false), "ignored");
});

test("a message with a subtype (edit/join/bot) is ignored", () => {
  const payload = { type: "event_callback", event: { type: "message", subtype: "message_changed", channel: "C1", channel_type: "channel", text: "x", ts: "5", thread_ts: "1" } } as SlackEventPayload;
  assert.equal(classifyEvent(payload, BOT, false), "ignored");
});

test("a message carrying a bot_id is treated as self (loop guard)", () => {
  const payload = { type: "event_callback", event: { type: "message", bot_id: "B1", channel: "C1", channel_type: "channel", text: "x", ts: "5", thread_ts: "1" } } as SlackEventPayload;
  assert.equal(classifyEvent(payload, BOT, false), "self");
});
