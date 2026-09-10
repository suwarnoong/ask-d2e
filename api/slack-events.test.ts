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

test("classifies a DM message from an admin as a wizard_turn candidate", () => {
  const payload = { type: "event_callback", event: { type: "message", user: "UADMIN", channel: "D1", text: "hi", ts: "1", channel_type: "im" } } as SlackEventPayload;
  assert.equal(classifyEvent(payload, BOT, false), "wizard_turn");
});

test("classifies an app_mention as app_mention, not colliding with the DM wizard branch", () => {
  const payload = { type: "event_callback", event: { type: "app_mention", user: "U1", channel: "C1", text: `<@${BOT}> hi`, ts: "1" } } as SlackEventPayload;
  assert.equal(classifyEvent(payload, BOT, false), "app_mention");
});

test("classifies anything else as ignored", () => {
  const payload = { type: "event_callback", event: { type: "reaction_added" } } as unknown as SlackEventPayload;
  assert.equal(classifyEvent(payload, BOT, false), "ignored");
});
