import { test } from "node:test";
import assert from "node:assert/strict";
import {
  slugFromSourceRepo,
  buildCraftingPrompt,
  summaryText,
  buildInitialBuildDispatchPayload,
  prefillFromEntry,
  applyWizardTurn,
} from "./addRepoWizard.js";
import { encodeState } from "./state.js";
import type { PromptSpec, RegistryEntry } from "../../kb/registry.js";
import type { SlackHistoryMessage } from "../../../api/_lib/slackApi.js";

const promptSpec: PromptSpec = {
  audience: "engineers",
  exampleQuestions: Array.from({ length: 20 }, (_, i) => `question number ${i} is quite long to force truncation of the payload`),
  focusAreas: Array.from({ length: 20 }, (_, i) => `focus area number ${i} is also fairly long text`),
  scopeNotes: "n/a",
};

test("slugFromSourceRepo drops the owner and normalizes to a slug", () => {
  assert.equal(slugFromSourceRepo("acme/Widgets-Service"), "widgets-service");
  assert.equal(slugFromSourceRepo("acme/some_thing"), "some-thing");
});

test("buildCraftingPrompt includes the raw freeform answers", () => {
  const prompt = buildCraftingPrompt({ audience: "engineers", exampleQuestions: "how does X work?" });
  assert.ok(prompt.includes("engineers"));
  assert.ok(prompt.includes("how does X work?"));
});

test("summaryText includes the sourceRepo and crafted promptSpec fields", () => {
  const text = summaryText("acme/widgets", { audience: "eng", exampleQuestions: ["q1"], focusAreas: ["f1"], scopeNotes: "n/a" });
  assert.ok(text.includes("acme/widgets"));
  assert.ok(text.includes("eng"));
  assert.ok(text.includes("q1"));
  assert.ok(/yes/i.test(text));
});

test("buildInitialBuildDispatchPayload has the exact workflow_dispatch shape", () => {
  const payload = buildInitialBuildDispatchPayload("widgets", "acme/widgets", promptSpec, "daily", "U1");
  assert.equal(payload.ref, "main");
  assert.equal(payload.inputs.repo_name, "widgets");
  assert.equal(payload.inputs.source_repo, "acme/widgets");
  assert.equal(payload.inputs.cadence, "daily");
  assert.equal(payload.inputs.created_by, "U1");
  assert.ok(payload.inputs.prompt_spec_json.length <= 1024);
});

test("buildInitialBuildDispatchPayload truncates a small promptSpec without dropping content", () => {
  const small: PromptSpec = { audience: "a", exampleQuestions: ["q1"], focusAreas: ["f1"], scopeNotes: "s" };
  const payload = buildInitialBuildDispatchPayload("widgets", "acme/widgets", small, "weekly", "U1");
  const parsed = JSON.parse(payload.inputs.prompt_spec_json);
  assert.deepEqual(parsed, small);
});

test("prefillFromEntry seeds answers from an existing registry entry", () => {
  const entry: RegistryEntry = {
    name: "acme",
    sourceRepo: "acme/widgets",
    promptSpec: { audience: "engineers", exampleQuestions: ["q1"], focusAreas: ["f1"], scopeNotes: "n/a" },
    cadence: "weekly",
    status: "active",
    createdBy: "U1",
    createdAt: "2026-01-01T00:00:00Z",
    lastRefreshedAt: null,
    lastAutoRefreshAt: null,
  };
  const answers = prefillFromEntry(entry);
  assert.equal(answers.audience, "engineers");
  assert.equal(answers.exampleQuestions, "q1");
  assert.equal(answers.focusAreas, "f1");
});

const stubCraft = async (answers: Record<string, string>) => ({
  audience: answers.audience ?? "",
  exampleQuestions: (answers.exampleQuestions ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  focusAreas: (answers.focusAreas ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  scopeNotes: answers.additionalNotes ?? "",
});

test("applyWizardTurn returns null when no bot message carries active state", async () => {
  const history: SlackHistoryMessage[] = [{ ts: "1", text: "hello", user: "U1" }];
  const result = await applyWizardTurn(history, "hi", "U1");
  assert.equal(result, null);
});

test("applyWizardTurn advances a freeform step and asks the next question", async () => {
  const encoded = encodeState("What audience is this for?", {
    active: true,
    step: "audience",
    sourceRepo: "acme/widgets",
    answers: {},
  });
  const history: SlackHistoryMessage[] = [{ ts: "1", text: encoded, bot_id: "B1" }];
  const result = await applyWizardTurn(history, "internal engineers", "U1");
  assert.ok(result);
  assert.equal(result!.state.answers.audience, "internal engineers");
  assert.equal(result!.state.step, "exampleQuestions");
  assert.equal(result!.dispatch, null);
});

test("applyWizardTurn auto-crafts after the cadence step and lands on confirmed", async () => {
  const encoded = encodeState("daily or weekly?", {
    active: true,
    step: "cadence",
    sourceRepo: "acme/widgets",
    answers: { audience: "eng", exampleQuestions: "q1", focusAreas: "f1" },
  });
  const history: SlackHistoryMessage[] = [{ ts: "1", text: encoded, bot_id: "B1" }];
  const result = await applyWizardTurn(history, "daily", "U1", { craft: stubCraft });
  assert.ok(result);
  assert.equal(result!.state.step, "confirmed");
  assert.ok(result!.state.answers.craftedSpecJson);
  assert.ok(/yes/i.test(result!.reply));
  assert.equal(result!.dispatch, null);
});

test("applyWizardTurn on confirmed + yes returns a dispatch payload and ends the wizard", async () => {
  const craftedSpec: PromptSpec = { audience: "eng", exampleQuestions: ["q1"], focusAreas: ["f1"], scopeNotes: "" };
  const encoded = encodeState("Look good? (yes/no)", {
    active: true,
    step: "confirmed",
    sourceRepo: "acme/widgets",
    answers: { cadence: "weekly", craftedSpecJson: JSON.stringify(craftedSpec) },
  });
  const history: SlackHistoryMessage[] = [{ ts: "1", text: encoded, bot_id: "B1" }];
  const result = await applyWizardTurn(history, "yes", "U1", { craft: stubCraft });
  assert.ok(result);
  assert.equal(result!.state.active, false);
  assert.ok(result!.dispatch);
  assert.equal(result!.dispatch!.inputs.source_repo, "acme/widgets");
  assert.equal(result!.dispatch!.inputs.repo_name, "widgets");
  assert.equal(result!.dispatch!.inputs.created_by, "U1");
});

test("applyWizardTurn on confirmed + a restatement re-crafts and stays on confirmed", async () => {
  const craftedSpec: PromptSpec = { audience: "eng", exampleQuestions: ["q1"], focusAreas: ["f1"], scopeNotes: "" };
  const encoded = encodeState("Look good? (yes/no)", {
    active: true,
    step: "confirmed",
    sourceRepo: "acme/widgets",
    answers: { audience: "eng", cadence: "weekly", craftedSpecJson: JSON.stringify(craftedSpec) },
  });
  const history: SlackHistoryMessage[] = [{ ts: "1", text: encoded, bot_id: "B1" }];
  const result = await applyWizardTurn(history, "actually also external partners", "U1", { craft: stubCraft });
  assert.ok(result);
  assert.equal(result!.state.step, "confirmed");
  assert.equal(result!.state.answers.additionalNotes, "actually also external partners");
  assert.equal(result!.dispatch, null);
});

test("applyWizardTurn handles cancel from any step", async () => {
  const encoded = encodeState("q", { active: true, step: "focusAreas", sourceRepo: "acme/widgets", answers: {} });
  const history: SlackHistoryMessage[] = [{ ts: "1", text: encoded, bot_id: "B1" }];
  const result = await applyWizardTurn(history, "cancel", "U1");
  assert.ok(result);
  assert.equal(result!.state.active, false);
  assert.equal(result!.dispatch, null);
});
