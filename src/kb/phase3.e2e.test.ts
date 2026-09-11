import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAllRepoKbs, answerQuestion } from "../../api/_lib/answer.js";
import { resolveRepoFromCitation } from "./repoResolution.js";
import { decideSelfHealAction } from "../../api/_lib/selfHeal.js";
import type { RegistryEntry } from "./registry.js";

function fixtureEntry(name: string, overrides: Partial<RegistryEntry> = {}): RegistryEntry {
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
    ...overrides,
  };
}

function makeFixtureRoot(): { root: string; registry: RegistryEntry[] } {
  const root = mkdtempSync(join(tmpdir(), "phase3-e2e-"));
  for (const name of ["widgets", "gadgets"]) {
    const dir = join(root, "repos", name, "knowledge-base", "00-overview");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "intro.md"), `# ${name}\nContent about ${name}.`);
  }
  const registry = [fixtureEntry("widgets"), fixtureEntry("gadgets")];
  writeFileSync(join(root, "repos.json"), JSON.stringify(registry, null, 2));
  return { root, registry };
}

test("covered answer round-trips a parseable citation that resolveRepoFromCitation extracts", async () => {
  const { root } = makeFixtureRoot();
  const files = readAllRepoKbs(root);
  assert.ok(files.some((f) => f.path === "repos/widgets/knowledge-base/00-overview/intro.md"));

  const stubClient = {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: "Widgets are things.\nCited: repos/widgets/knowledge-base/00-overview/intro.md" }],
      }),
    },
  };
  const result = await answerQuestion("what are widgets?", [], stubClient as any);
  assert.equal(result.covered, true);
  assert.equal(resolveRepoFromCitation(result.text), "widgets");
});

test("uncovered question with a plausible, non-cooling-down repo -> dispatch", async () => {
  const { registry } = makeFixtureRoot();
  const classify = async () => "gadgets";
  const decision = await decideSelfHealAction("what about gadgets internals?", registry, new Date(), classify);
  assert.deepEqual(decision, { action: "dispatch", repoName: "gadgets" });
});

test("uncovered question classified as none -> admin-fallback", async () => {
  const { registry } = makeFixtureRoot();
  const classify = async () => null;
  const decision = await decideSelfHealAction("something totally unrelated", registry, new Date(), classify);
  assert.deepEqual(decision, { action: "admin-fallback" });
});
