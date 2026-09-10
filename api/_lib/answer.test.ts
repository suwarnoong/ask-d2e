import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAllRepoKbs, renderKbForPrompt, answerQuestion, NO_KB_MATCH } from "./answer.js";
import type { RegistryEntry } from "../../src/kb/registry.js";

function fixtureEntry(name: string): RegistryEntry {
  return {
    name,
    sourceRepo: `acme/${name}`,
    promptSpec: { audience: "engineers", exampleQuestions: [], focusAreas: [], scopeNotes: "" },
    cadence: "weekly",
    status: "active",
    createdBy: "U1",
    createdAt: "2026-01-01T00:00:00Z",
    lastRefreshedAt: null,
    lastAutoRefreshAt: null,
  };
}

function makeFixtureRoot(repoNames: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "answer-root-"));
  for (const name of repoNames) {
    const dir = join(root, "repos", name, "knowledge-base", "00-overview");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "intro.md"), `# ${name} intro\nSome content about ${name}.`);
  }
  return root;
}

test("readAllRepoKbs walks every configured repo's kb folder", () => {
  const root = makeFixtureRoot(["widgets", "gadgets"]);
  const files = readAllRepoKbs(root);
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    "repos/gadgets/knowledge-base/00-overview/intro.md",
    "repos/widgets/knowledge-base/00-overview/intro.md",
  ]);
});

test("renderKbForPrompt forces the index-only fallback over a small forced budget with >=2 repos", () => {
  const root = makeFixtureRoot(["widgets", "gadgets"]);
  const files = readAllRepoKbs(root);
  const registry = [fixtureEntry("widgets"), fixtureEntry("gadgets")];
  const rendered = renderKbForPrompt(files, registry, 10);
  assert.ok(rendered.includes("widgets"));
  assert.ok(rendered.includes("gadgets"));
  assert.ok(!rendered.includes("Some content about widgets"));
});

test("renderKbForPrompt includes a repo index for meta-questions", () => {
  const root = makeFixtureRoot(["widgets"]);
  const files = readAllRepoKbs(root);
  const registry = [fixtureEntry("widgets")];
  const rendered = renderKbForPrompt(files, registry);
  assert.ok(rendered.includes("widgets"));
  assert.ok(rendered.includes("engineers"));
});

test("answerQuestion returns covered=true for a normal answer", async () => {
  const stubClient = {
    messages: { create: async () => ({ content: [{ type: "text", text: "The answer is 42. Cited: repos/widgets/x.md" }] }) },
  };
  const result = await answerQuestion("what is the answer?", [], stubClient as any);
  assert.equal(result.covered, true);
  assert.ok(result.text.includes("42"));
});

test("answerQuestion requests a generous max_tokens so detailed answers aren't cut off", async () => {
  let capturedMaxTokens: number | undefined;
  const stubClient = {
    messages: {
      create: async (params: any) => {
        capturedMaxTokens = params.max_tokens;
        return { content: [{ type: "text", text: "ok" }] };
      },
    },
  };
  const originalEnv = process.env.ANSWER_MAX_TOKENS;
  delete process.env.ANSWER_MAX_TOKENS;
  try {
    await answerQuestion("anything", [], stubClient as any);
    assert.equal(capturedMaxTokens, 4096);
  } finally {
    if (originalEnv === undefined) delete process.env.ANSWER_MAX_TOKENS;
    else process.env.ANSWER_MAX_TOKENS = originalEnv;
  }
});

test("answerQuestion strips the NO_KB_MATCH sentinel and reports covered=false", async () => {
  const stubClient = {
    messages: { create: async () => ({ content: [{ type: "text", text: `${NO_KB_MATCH}\nSorry, nothing covers that.` }] }) },
  };
  const result = await answerQuestion("something obscure", [], stubClient as any);
  assert.equal(result.covered, false);
  assert.equal(result.text.trim(), "Sorry, nothing covers that.");
});

test("answerQuestion strips a markdown-bolded NO_KB_MATCH sentinel (observed production format)", async () => {
  const stubClient = {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: "**NO_KB_MATCH\n\nThe knowledge base doesn't contain information about HANA databases in general..." }],
      }),
    },
  };
  const result = await answerQuestion("tell me about HANA database", [], stubClient as any);
  assert.equal(result.covered, false);
  assert.ok(!result.text.includes("NO_KB_MATCH"));
  assert.ok(result.text.startsWith("The knowledge base"));
});

test("answerQuestion strips NO_KB_MATCH even when the model doesn't lead with it", async () => {
  const stubClient = {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: "Based on the knowledge base: NO_KB_MATCH The docs don't cover HANA in general, but here's what's there about D2E's use of it." }],
      }),
    },
  };
  const result = await answerQuestion("tell me about HANA database", [], stubClient as any);
  assert.equal(result.covered, false);
  assert.ok(!result.text.includes("NO_KB_MATCH"));
  assert.ok(result.text.includes("Based on the knowledge base:"));
  assert.ok(result.text.includes("The docs don't cover HANA"));
});
