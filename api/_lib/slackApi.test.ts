import { test } from "node:test";
import assert from "node:assert/strict";
import { mapHistoryToTurns, stripMention, type SlackHistoryMessage } from "./slackApi.js";

test("mapHistoryToTurns maps a bot message to assistant role", () => {
  const messages: SlackHistoryMessage[] = [
    { ts: "1", text: "hi", bot_id: "B1" },
  ];
  const turns = mapHistoryToTurns(messages, "UBOT");
  assert.deepEqual(turns, [{ role: "assistant", text: "hi" }]);
});

test("mapHistoryToTurns maps a user message to user role and strips bot mention", () => {
  const messages: SlackHistoryMessage[] = [
    { ts: "2", text: "<@UBOT> what is this?", user: "U1" },
  ];
  const turns = mapHistoryToTurns(messages, "UBOT");
  assert.deepEqual(turns, [{ role: "user", text: "what is this?" }]);
});

test("mapHistoryToTurns skips system-subtype messages", () => {
  const messages: SlackHistoryMessage[] = [
    { ts: "3", text: "joined", user: "U1", subtype: "channel_join" },
    { ts: "4", text: "real message", user: "U1" },
  ];
  const turns = mapHistoryToTurns(messages, "UBOT");
  assert.deepEqual(turns, [{ role: "user", text: "real message" }]);
});

test("mapHistoryToTurns drops the excluded ts", () => {
  const messages: SlackHistoryMessage[] = [
    { ts: "5", text: "keep", user: "U1" },
    { ts: "6", text: "drop me", user: "U1" },
  ];
  const turns = mapHistoryToTurns(messages, "UBOT", "6");
  assert.deepEqual(turns, [{ role: "user", text: "keep" }]);
});

test("stripMention removes a known bot user id mention", () => {
  assert.equal(stripMention("<@UBOT> hello", "UBOT"), "hello");
});

test("stripMention removes any bot-shaped mention when botUserId is unknown", () => {
  assert.equal(stripMention("<@U12345ABC> hello", undefined), "hello");
});
