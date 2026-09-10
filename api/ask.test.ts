import { test } from "node:test";
import assert from "node:assert/strict";
import { pickAckPhrase, buildAnswerBlocks } from "./ask.js";

test("pickAckPhrase is deterministic for the same question", () => {
  const a = pickAckPhrase("how does auth work?");
  const b = pickAckPhrase("how does auth work?");
  assert.equal(a, b);
});

test("pickAckPhrase can return different phrases for different questions", () => {
  const phrases = new Set([
    pickAckPhrase("question one"),
    pickAckPhrase("a totally different question"),
    pickAckPhrase("yet another one, quite unlike the others"),
  ]);
  assert.ok(phrases.size >= 2, "expected at least some variation across distinct questions");
});

test("buildAnswerBlocks caps the packed question in the button value at ~1900 chars", () => {
  const longQuestion = "q".repeat(3000);
  const blocks = buildAnswerBlocks(longQuestion, "an answer", true);
  const actionsBlock = blocks.find((b) => b.type === "actions") as any;
  const value = actionsBlock.elements[0].value as string;
  assert.ok(value.length <= 1900);
});

test("buildAnswerBlocks includes the question and chunked answer body", () => {
  const blocks = buildAnswerBlocks("what is X?", "X is a thing.", true);
  const text = JSON.stringify(blocks);
  assert.ok(text.includes("what is X?"));
  assert.ok(text.includes("X is a thing."));
});

test("buildAnswerBlocks still includes feedback buttons for an uncovered answer", () => {
  const blocks = buildAnswerBlocks("obscure question", "not covered", false);
  assert.ok(blocks.some((b) => b.type === "actions"));
});
