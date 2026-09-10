import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRepoFromCitation, buildClassificationPrompt, classifyRepoForQuestion } from "./repoResolution.js";
import type { RegistryEntry } from "./registry.js";

function entry(name: string): RegistryEntry {
  return {
    name,
    sourceRepo: `acme/${name}`,
    promptSpec: { audience: "engineers", exampleQuestions: [], focusAreas: [`the ${name} service`], scopeNotes: "" },
    cadence: "weekly",
    status: "active",
    createdBy: "U1",
    createdAt: "2026-01-01T00:00:00Z",
    lastRefreshedAt: null,
    lastAutoRefreshAt: null,
  };
}

test("resolveRepoFromCitation returns null with zero citations", () => {
  assert.equal(resolveRepoFromCitation("no citations here"), null);
});

test("resolveRepoFromCitation returns the name with exactly one distinct citation", () => {
  const text = "See repos/acme-widgets/03-api/query.md and repos/acme-widgets/00-overview/intro.md for details.";
  assert.equal(resolveRepoFromCitation(text), "acme-widgets");
});

test("resolveRepoFromCitation returns null with two distinct citations", () => {
  const text = "See repos/acme-widgets/x.md and repos/other-repo/y.md.";
  assert.equal(resolveRepoFromCitation(text), null);
});

test("buildClassificationPrompt includes registry metadata but not full KB bodies", () => {
  const prompt = buildClassificationPrompt("how does auth work?", [entry("widgets"), entry("gadgets")]);
  assert.ok(prompt.includes("widgets"));
  assert.ok(prompt.includes("the widgets service"));
  assert.ok(prompt.includes("gadgets"));
  assert.ok(prompt.includes("how does auth work?"));
});

test("classifyRepoForQuestion returns null when the stub client says none", async () => {
  const stubClient = { messages: { create: async () => ({ content: [{ type: "text", text: "none" }] }) } };
  const result = await classifyRepoForQuestion("q", [entry("widgets")], stubClient as any);
  assert.equal(result, null);
});

test("classifyRepoForQuestion returns the named repo from the stub client", async () => {
  const stubClient = { messages: { create: async () => ({ content: [{ type: "text", text: "widgets" }] }) } };
  const result = await classifyRepoForQuestion("q", [entry("widgets")], stubClient as any);
  assert.equal(result, "widgets");
});
