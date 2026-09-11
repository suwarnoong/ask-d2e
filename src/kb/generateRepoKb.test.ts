import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepoPrompt, generateRepoKb } from "./generateRepoKb.js";
import type { PromptSpec } from "./registry.js";

const SPEC: PromptSpec = {
  audience: "engineers integrating D2E",
  exampleQuestions: ["How does Atlas3 build a cohort?"],
  focusAreas: ["cohort construction", "OHDSI integration"],
  scopeNotes: "Do not document deployment.",
};

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "srcrepo-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# Atlas3\n\nA cohort builder.");
  writeFileSync(join(dir, "index.ts"), "export const x = 1;\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  return dir;
}

const auth = { claudeOauthToken: "test-token", claudeModel: "test-model" };

function options(sourceDir: string, contractNote?: string) {
  return {
    sourceDir,
    repoName: "atlas3",
    sourceRepo: "OHDSI/Atlas3",
    promptSpec: SPEC,
    target: { pathPrefix: "snapshots/develop/generated/atlas3/", contractNote },
    auth,
  };
}

test("buildRepoPrompt names the target prefix and the repo's scope", () => {
  const prompt = buildRepoPrompt({ ...options(makeRepo()), callClaude: async () => "" });
  assert.match(prompt, /snapshots\/develop\/generated\/atlas3\//);
  assert.match(prompt, /cohort construction/);
  assert.match(prompt, /Do not document deployment/);
  assert.match(prompt, /index\.ts/);
});

test("buildRepoPrompt adds the contract note only when supplied", () => {
  const withNote = buildRepoPrompt({
    ...options(makeRepo(), "This is an upstream contract specification, not shipped in D2E."),
    callClaude: async () => "",
  });
  assert.match(withNote, /contract specification/);
  assert.doesNotMatch(
    buildRepoPrompt({ ...options(makeRepo()), callClaude: async () => "" }),
    /contract specification/,
  );
});

test("generateRepoKb returns the parsed plan from the model reply", async () => {
  const reply = JSON.stringify({
    summary: "Built the Atlas3 KB.",
    changes: [
      {
        path: "snapshots/develop/generated/atlas3/00-overview/intro.md",
        action: "create",
        rationale: "orientation",
        source_prs: [],
        content: "# Atlas3\n\nOverview.",
      },
    ],
  });
  const plan = await generateRepoKb({ ...options(makeRepo()), callClaude: async () => reply });
  assert.equal(plan.summary, "Built the Atlas3 KB.");
  assert.deepEqual(plan.changes.map((c) => c.path), [
    "snapshots/develop/generated/atlas3/00-overview/intro.md",
  ]);
});

test("generateRepoKb passes the source checkout as the working directory", async () => {
  const sourceDir = makeRepo();
  let seenCwd: string | undefined;
  let seenTools: string[] | undefined;
  await generateRepoKb({
    ...options(sourceDir),
    callClaude: async (_prompt, _auth, opts) => {
      seenCwd = opts?.cwd;
      seenTools = opts?.allowedTools;
      return JSON.stringify({ summary: "s", changes: [] });
    },
  });
  assert.equal(seenCwd, sourceDir);
  assert.deepEqual(seenTools, ["Read", "Grep", "Glob"]);
});

test("generateRepoKb surfaces a model failure rather than returning an empty plan", async () => {
  await assert.rejects(
    generateRepoKb({ ...options(makeRepo()), callClaude: async () => "not json at all" }),
  );
});
