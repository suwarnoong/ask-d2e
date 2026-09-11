import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIncrementalPrompt, renderPrData } from "./incrementalPrompt.js";
import type { DigestData, PrSummary } from "../shared/githubDiff.js";
import type { PromptSpec } from "./registry.js";

function pr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    number: 42,
    title: "Swap the query planner",
    author: "alice",
    html_url: "https://github.com/acme/widgets/pull/42",
    additions: 10,
    deletions: 3,
    changed_files: 2,
    labels: ["core"],
    body_excerpt: "Replaces the planner.",
    files: ["src/plan.ts"],
    diff: "### modified src/plan.ts (+10/-3)\n@@ -1 +1 @@",
    diff_truncated: false,
    ...overrides,
  };
}

function digest(overrides: Partial<DigestData> = {}): DigestData {
  const prs = overrides.prs ?? [pr()];
  return {
    repo: "acme/widgets",
    since: "2026-09-01T00:00:00.000Z",
    generatedAt: "2026-09-11T00:00:00.000Z",
    prs,
    byAuthor: [],
    totals: { prCount: prs.length, authorCount: 1, additions: 10, deletions: 3 },
    ...overrides,
  };
}

const spec: PromptSpec = {
  audience: "internal colleagues",
  exampleQuestions: ["How do I run a cohort?"],
  focusAreas: ["The query engine", "Deployment"],
  scopeNotes: "Ignore the marketing site.",
};

test("renderPrData includes the PR header, churn, and diff", () => {
  const text = renderPrData(digest());
  assert.match(text, /PR #42: Swap the query planner/);
  assert.match(text, /Author: alice/);
  assert.match(text, /\+10\/-3 across 2 file\(s\)/);
  assert.match(text, /### modified src\/plan\.ts/);
});

test("renderPrData warns explicitly when a diff was truncated", () => {
  const text = renderPrData(digest({ prs: [pr({ diff_truncated: true })] }));
  assert.match(text, /TRUNCATED/);
});

test("renderPrData shows (none) for a PR with no description", () => {
  assert.match(renderPrData(digest({ prs: [pr({ body_excerpt: "" })] })), /Description: \(none\)/);
});

test("buildIncrementalPrompt carries the path prefix, focus areas, and scope notes", () => {
  const prompt = buildIncrementalPrompt("acme/widgets", "widgets", spec, digest(), "===== FILE: a.md =====\n# A");
  assert.match(prompt, /repos\/widgets\/knowledge-base\//);
  assert.match(prompt, /- The query engine/);
  assert.match(prompt, /Ignore the marketing site\./);
  assert.match(prompt, /internal colleagues/);
  assert.match(prompt, /===== FILE: a\.md =====/);
});

test("buildIncrementalPrompt tells the model the diff is a pointer, not the only source of truth", () => {
  const prompt = buildIncrementalPrompt("acme/widgets", "widgets", spec, digest(), "");
  assert.match(prompt, /POINTER, not the only source of truth/);
  assert.match(prompt, /EMPTY changes array is correct and expected/);
});

test("buildIncrementalPrompt omits the scope-notes line when there are none", () => {
  const prompt = buildIncrementalPrompt("acme/widgets", "widgets", { ...spec, scopeNotes: "" }, digest(), "");
  assert.doesNotMatch(prompt, /Scope notes/);
});
