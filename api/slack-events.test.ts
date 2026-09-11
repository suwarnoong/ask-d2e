import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEvent, threadFollowupDecision, type SlackEventPayload } from "./slack-events.js";
import type { SlackHistoryMessage } from "./_lib/slackApi.js";

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

// thread owner = author of the root message; bot replied in the thread below it.
const ownedThread: SlackHistoryMessage[] = [
  { ts: "1", text: "<@UBOT> what is trex?", user: "UOWNER" },
  { ts: "2", text: "Trex is...", bot_id: "B1" },
];

test("threadFollowupDecision answers an untagged reply from the thread owner", () => {
  assert.equal(threadFollowupDecision(ownedThread, "UOWNER", BOT), "answer");
});

test("threadFollowupDecision ignores an untagged reply from a non-owner", () => {
  assert.equal(threadFollowupDecision(ownedThread, "USOMEONE_ELSE", BOT), "not-owner");
});

test("threadFollowupDecision ignores a thread the bot never took part in", () => {
  const noBot: SlackHistoryMessage[] = [
    { ts: "1", text: "hey", user: "UOWNER" },
    { ts: "2", text: "reply", user: "UOWNER" },
  ];
  assert.equal(threadFollowupDecision(noBot, "UOWNER", BOT), "not-participant");
});

test("threadFollowupDecision treats a bot-rooted thread (/ask) as having no untagged owner", () => {
  const askThread: SlackHistoryMessage[] = [
    { ts: "1", text: "Looking that up...", bot_id: "B1", user: BOT },
    { ts: "2", text: "Trex is...", bot_id: "B1", user: BOT },
  ];
  assert.equal(threadFollowupDecision(askThread, "UASKER", BOT), "not-owner");
});
