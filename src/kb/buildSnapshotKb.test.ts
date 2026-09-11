import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSnapshotKb, type BuildSnapshotKbInput } from "./buildSnapshotKb.js";

const auth = { claudeOauthToken: "test-token", claudeModel: "test-model" };

/** Creates a real git checkout so the prompt builder can run `git ls-files`. */
function fakeCheckout(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# Repo\n\nReadme.");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
}

function planFor(repo: string): string {
  return JSON.stringify({
    summary: `${repo} kb`,
    changes: [
      {
        path: `snapshots/develop/generated/${repo}/00-overview/intro.md`,
        action: "create",
        rationale: "orientation",
        source_prs: [],
        content: `# ${repo}\n\nOverview of ${repo}.`,
      },
    ],
  });
}

function repoFromPrompt(prompt: string): string {
  return prompt.match(/generated\/([a-z0-9]+)\//)?.[1] ?? "unknown";
}

function makeInput(
  kbRoot: string,
  workRoot: string,
  overrides: Partial<BuildSnapshotKbInput> = {},
): BuildSnapshotKbInput {
  return {
    kbRoot,
    snapshotId: "develop",
    refs: { d2e: "develop", atlas3: "269a00a", trex: "5ce4275" },
    auth,
    workRoot,
    deps: {
      clone: ({ dir }) => fakeCheckout(dir),
      callClaude: async (prompt) => planFor(repoFromPrompt(prompt)),
    },
    ...overrides,
  };
}

test("buildSnapshotKb generates every repo and indexes them in the manifest", async () => {
  const kbRoot = mkdtempSync(join(tmpdir(), "kb-"));
  const result = await buildSnapshotKb(makeInput(kbRoot, mkdtempSync(join(tmpdir(), "work-"))));

  assert.deepEqual(result.repos.map((r) => r.repoName).sort(), ["atlas3", "d2e", "trex"]);
  assert.equal(result.manifestEntries, 3);

  const manifest = JSON.parse(readFileSync(join(kbRoot, "snapshots/develop/manifest.json"), "utf8"));
  assert.deepEqual(
    manifest.entries.map((e: { path: string }) => e.path).sort(),
    [
      "snapshots/develop/generated/atlas3/00-overview/intro.md",
      "snapshots/develop/generated/d2e/00-overview/intro.md",
      "snapshots/develop/generated/trex/00-overview/intro.md",
    ],
  );
});

test("a failing repo aborts the build with nothing written", async () => {
  const kbRoot = mkdtempSync(join(tmpdir(), "kb-fail-"));
  const input = makeInput(kbRoot, mkdtempSync(join(tmpdir(), "work-")), {
    deps: {
      clone: ({ dir, repo }) => {
        if (repo.includes("trex")) throw new Error("could not fetch pinned ref 5ce4275");
        fakeCheckout(dir);
      },
      callClaude: async (prompt) => planFor(repoFromPrompt(prompt)),
    },
  });

  await assert.rejects(() => buildSnapshotKb(input), /5ce4275/);
  assert.throws(() => readFileSync(join(kbRoot, "snapshots/develop/generated/atlas3/00-overview/intro.md")));
  assert.throws(() => readFileSync(join(kbRoot, "snapshots/develop/manifest.json")));
});

test("generated citations resolve back to their repo", async () => {
  const kbRoot = mkdtempSync(join(tmpdir(), "kb-cite-"));
  await buildSnapshotKb(makeInput(kbRoot, mkdtempSync(join(tmpdir(), "work-"))));
  const { resolveRepoFromCitation } = await import("./repoResolution.js");
  assert.equal(
    resolveRepoFromCitation("See snapshots/develop/generated/atlas3/00-overview/intro.md"),
    "atlas3",
  );
  assert.equal(
    resolveRepoFromCitation("See snapshots/develop/generated/trex/00-overview/intro.md"),
    "trex",
  );
});
