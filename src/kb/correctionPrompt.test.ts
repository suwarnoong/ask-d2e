import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCorrectionPrompt } from "./correctionPrompt.js";

test("fix mode grounds the correction in code, not existing KB wording", () => {
  const prompt = buildCorrectionPrompt("fix", "acme/widgets", "how does auth work?", "it uses OAuth", undefined, undefined);
  assert.ok(/NOT the existing KB wording|not the existing kb wording/i.test(prompt));
  assert.ok(prompt.includes("acme/widgets"));
  assert.ok(prompt.includes("how does auth work?"));
});

test("fix mode instructs an empty changes array if the original answer was correct", () => {
  const prompt = buildCorrectionPrompt("fix", "acme/widgets", "q", "a", undefined, undefined);
  assert.ok(/empty changes array/i.test(prompt));
});

test("gap-fill mode includes file-tree/readme scope-bounding content", () => {
  const prompt = buildCorrectionPrompt("gap-fill", "acme/widgets", "what about caching?", "", "src/\n  a.ts", "# Widgets\nA repo.");
  assert.ok(prompt.includes("src/"));
  assert.ok(prompt.includes("# Widgets\nA repo."));
  assert.ok(/explore the real source/i.test(prompt));
});

test("both modes instruct the same KbPlan output shape", () => {
  const fixPrompt = buildCorrectionPrompt("fix", "acme/widgets", "q", "a", undefined, undefined);
  const gapPrompt = buildCorrectionPrompt("gap-fill", "acme/widgets", "q", "", "tree", "readme");
  for (const p of [fixPrompt, gapPrompt]) {
    assert.ok(/summary/.test(p) && /changes/.test(p));
  }
});
