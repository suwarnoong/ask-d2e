import { test } from "node:test";
import assert from "node:assert/strict";
import { STEP_ORDER, nextStep, applyAnswer } from "./steps.js";
import type { WizardState } from "./state.js";

function state(step: string, answers: Record<string, string> = {}): WizardState {
  return { active: true, step, sourceRepo: "acme/widgets", answers };
}

test("nextStep walks the full sequence in order", () => {
  for (let i = 0; i < STEP_ORDER.length - 1; i++) {
    assert.equal(nextStep(STEP_ORDER[i]), STEP_ORDER[i + 1]);
  }
});

test("nextStep on the last step stays on the last step", () => {
  const last = STEP_ORDER[STEP_ORDER.length - 1];
  assert.equal(nextStep(last), last);
});

test("applyAnswer records the answer and advances the step", () => {
  const result = applyAnswer(state("audience"), "internal engineers");
  assert.equal(result.answers.audience, "internal engineers");
  assert.equal(result.step, nextStep("audience"));
  assert.equal(result.active, true);
});

test('applyAnswer treats "cancel" as an escape hatch from any step', () => {
  const result = applyAnswer(state("focusAreas"), "cancel");
  assert.equal(result.active, false);
});

test('applyAnswer on the cadence step accepts "Daily" and "weekly" case-insensitively', () => {
  assert.equal(applyAnswer(state("cadence"), "Daily").answers.cadence, "daily");
  assert.equal(applyAnswer(state("cadence"), "weekly").answers.cadence, "weekly");
});

test("applyAnswer on the cadence step defaults to weekly for an unrecognized value", () => {
  assert.equal(applyAnswer(state("cadence"), "whenever").answers.cadence, "weekly");
});
