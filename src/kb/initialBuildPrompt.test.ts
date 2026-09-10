import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFileTreeOverview, buildInitialBuildPrompt } from "./initialBuildPrompt.js";
import type { PromptSpec } from "./registry.js";

const promptSpec: PromptSpec = {
  audience: "internal engineers",
  exampleQuestions: ["how does auth work?"],
  focusAreas: ["the API layer"],
  scopeNotes: "skip the legacy admin UI",
};

test("buildFileTreeOverview groups by top-level directory", () => {
  const overview = buildFileTreeOverview(["src/a.ts", "src/b.ts", "docs/readme.md"], 500, 3);
  assert.ok(overview.includes("src/"));
  assert.ok(overview.includes("docs/"));
  assert.ok(overview.includes("a.ts"));
});

test("buildFileTreeOverview notes truncation when file count exceeds the cap", () => {
  const files = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`);
  const overview = buildFileTreeOverview(files, 5, 20);
  assert.ok(/truncat/i.test(overview));
});

test("buildFileTreeOverview omits the truncation note when under the cap", () => {
  const overview = buildFileTreeOverview(["src/a.ts"], 500, 1);
  assert.ok(!/truncat/i.test(overview));
});

test("buildInitialBuildPrompt includes the promptSpec fields verbatim", () => {
  const prompt = buildInitialBuildPrompt("acme/widgets", promptSpec, ["src/a.ts"], "# Widgets\nA repo.", 1);
  assert.ok(prompt.includes("internal engineers"));
  assert.ok(prompt.includes("how does auth work?"));
  assert.ok(prompt.includes("the API layer"));
  assert.ok(prompt.includes("skip the legacy admin UI"));
});

test("buildInitialBuildPrompt includes the readme content and category-folder + output-shape instructions", () => {
  const prompt = buildInitialBuildPrompt("acme/widgets", promptSpec, ["src/a.ts"], "# Widgets\nA repo.", 1);
  assert.ok(prompt.includes("# Widgets\nA repo."));
  assert.ok(/00-overview/.test(prompt));
  assert.ok(/summary/.test(prompt) && /changes/.test(prompt));
  assert.ok(/do not attempt to read every\s+file/i.test(prompt));
});
