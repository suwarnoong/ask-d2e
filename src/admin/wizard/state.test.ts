import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeState, decodeState, type WizardState } from "./state.js";

const state: WizardState = {
  active: true,
  step: "audience",
  sourceRepo: "acme/widgets",
  answers: {},
};

test("encodeState/decodeState round-trip", () => {
  const encoded = encodeState("What audience is this for?", state);
  const decoded = decodeState(encoded);
  assert.deepEqual(decoded, state);
});

test("decodeState returns null when no state blob is present", () => {
  assert.equal(decodeState("just a plain message, no state here"), null);
});

test("decodeState returns null when active is false", () => {
  const encoded = encodeState("cancelled", { ...state, active: false });
  assert.equal(decodeState(encoded), null);
});

test("decodeState returns null on a malformed trailing blob", () => {
  assert.equal(decodeState("question\n\nASK_D2E_WIZARD_STATE: {not valid json"), null);
});

test("decodeState tolerates trailing whitespace after the blob", () => {
  const encoded = encodeState("q", state) + "\n\n  \n";
  assert.deepEqual(decodeState(encoded), state);
});
