import { test } from "node:test";
import assert from "node:assert/strict";
import { stripFences, balancedFrom, jsonCandidates, parseKbResponse } from "./responseParsing.js";

test("stripFences removes a single ```json wrapper", () => {
  const text = '```json\n{"a":1}\n```';
  assert.equal(stripFences(text), '{"a":1}');
});

test("stripFences leaves plain text unchanged", () => {
  assert.equal(stripFences('{"a":1}'), '{"a":1}');
});

test("balancedFrom finds the balanced object ignoring braces inside string literals", () => {
  const text = 'prefix {"a": "a brace } inside a string", "b": 2} suffix';
  const start = text.indexOf("{");
  const result = balancedFrom(text, start);
  assert.equal(result, '{"a": "a brace } inside a string", "b": 2}');
});

test("balancedFrom handles escaped quotes inside strings", () => {
  const text = '{"a": "she said \\"hi\\""}';
  const result = balancedFrom(text, 0);
  assert.equal(result, text);
});

test("balancedFrom returns null when never balanced", () => {
  assert.equal(balancedFrom('{"a": 1', 0), null);
});

test("jsonCandidates prefers fenced blocks first", () => {
  const text = 'noise {"decoy": true} more noise\n```json\n{"changes": []}\n```';
  const candidates = jsonCandidates(text);
  assert.equal(candidates[0], '{"changes": []}');
});

test("parseKbResponse parses a clean fenced JSON plan", () => {
  const text = '```json\n{"summary":"s","changes":[{"path":"repos/a/kb/x.md","action":"create","rationale":"r","source_prs":[1],"content":"c"}]}\n```';
  const plan = parseKbResponse(text);
  assert.equal(plan.summary, "s");
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0].path, "repos/a/kb/x.md");
});

test("parseKbResponse parses prose-wrapped JSON with no fence", () => {
  const text = 'Here is the plan:\n{"summary":"ok","changes":[]}\nHope that helps!';
  const plan = parseKbResponse(text);
  assert.equal(plan.summary, "ok");
  assert.deepEqual(plan.changes, []);
});

test("parseKbResponse picks the candidate with a valid changes array over an inline example", () => {
  const text = [
    'Rationale: an example bad plan looks like {"foo": "bar"} and should be avoided.',
    "The real plan:",
    '{"summary":"real","changes":[{"path":"repos/a/kb/x.md","action":"update","rationale":"r","source_prs":[],"content":"c"}]}',
  ].join("\n");
  const plan = parseKbResponse(text);
  assert.equal(plan.summary, "real");
});

test("parseKbResponse defaults source_prs to [] when absent", () => {
  const text = '{"summary":"s","changes":[{"path":"repos/a/kb/x.md","action":"create","rationale":"r","content":"c"}]}';
  const plan = parseKbResponse(text);
  assert.deepEqual(plan.changes[0].source_prs, []);
});

test("parseKbResponse throws with a truncated excerpt when changes is missing entirely", () => {
  const text = "Sorry, I could not find anything relevant to report.";
  assert.throws(() => parseKbResponse(text), /could not find|no valid|changes/i);
});

test("parseKbResponse throws on an invalid change entry (bad action)", () => {
  const text = '{"summary":"s","changes":[{"path":"repos/a/kb/x.md","action":"delete","rationale":"r","content":"c"}]}';
  assert.throws(() => parseKbResponse(text));
});
