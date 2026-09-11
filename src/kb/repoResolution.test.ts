import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRepoFromCitation, hasKbCitation, buildClassificationPrompt, classifyRepoForQuestion } from "./repoResolution.js";
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

test("hasKbCitation is true when any KB path is cited (even multiple repos)", () => {
  assert.equal(hasKbCitation("Source: repos/acme-widgets/00-overview/intro.md"), true);
  assert.equal(hasKbCitation("See repos/a/x.md and repos/b/y.md"), true);
});

test("hasKbCitation is false for a genuine miss with no citation", () => {
  assert.equal(hasKbCitation("I don't have information about dinosaurs in this knowledge base."), false);
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

test("resolveRepoFromCitation resolves a snapshot generated-KB path", () => {
  assert.equal(
    resolveRepoFromCitation("See snapshots/develop/generated/atlas3/02-frontend/cohort.md"),
    "atlas3",
  );
});

test("resolveRepoFromCitation maps a snapshot docs path to data2evidence", () => {
  assert.equal(
    resolveRepoFromCitation("See snapshots/v0.18.1-beta/docs/2-admin_guide/5-setup/cli.md"),
    "data2evidence",
  );
});

test("resolveRepoFromCitation still resolves the legacy repos path", () => {
  assert.equal(
    resolveRepoFromCitation("See repos/data2evidence/knowledge-base/00-overview/intro.md"),
    "data2evidence",
  );
});

test("resolveRepoFromCitation refuses to resolve a curated FAQ citation", () => {
  assert.equal(resolveRepoFromCitation("See curated/faq/faq-03.md"), null);
});

test("resolveRepoFromCitation refuses to resolve the shared WebAPI contract", () => {
  assert.equal(resolveRepoFromCitation("See repos/_shared/webapi-contract/sources.md"), null);
});

test("resolveRepoFromCitation returns null when two different repos are cited", () => {
  const text = "snapshots/develop/generated/atlas3/a.md and snapshots/develop/generated/trex/b.md";
  assert.equal(resolveRepoFromCitation(text), null);
});

test("resolveRepoFromCitation resolves when one repo is cited twice", () => {
  const text = "snapshots/develop/generated/trex/a.md and snapshots/develop/generated/trex/b.md";
  assert.equal(resolveRepoFromCitation(text), "trex");
});

test("hasKbCitation recognises every citation shape the answer engine can emit", () => {
  for (const path of [
    "repos/data2evidence/knowledge-base/00-overview/intro.md",
    "snapshots/develop/docs/2-admin_guide/5-setup/cli.md",
    "snapshots/develop/generated/trex/01-architecture/engine.md",
    "repos/_shared/webapi-contract/sources.md",
    "curated/faq/faq-01.md",
  ]) {
    assert.equal(hasKbCitation(`Answer text. ${path}`), true, `should match ${path}`);
  }
});

test("hasKbCitation does not fire on ordinary prose", () => {
  assert.equal(hasKbCitation("There are no citations in this sentence."), false);
});
