import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSharedContract } from "./buildSharedContract.js";

const auth = { claudeOauthToken: "test-token", claudeModel: "test-model" };

/** The prompt builder runs `git ls-files`, so the fake clone must produce a real checkout. */
function fakeCheckout(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# WebAPI\n\nUpstream contract spec.");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
}

test("buildSharedContract writes the contract tier under repos/_shared", async () => {
  const kbRoot = mkdtempSync(join(tmpdir(), "kb-contract-"));
  const result = await buildSharedContract({
    kbRoot,
    workRoot: mkdtempSync(join(tmpdir(), "work-")),
    auth,
    deps: {
      clone: ({ dir }) => fakeCheckout(dir),
      callClaude: async () =>
        JSON.stringify({
          summary: "WebAPI contract KB",
          changes: [
            {
              path: "repos/_shared/webapi-contract/00-overview/sources.md",
              action: "create",
              rationale: "orientation",
              source_prs: [],
              content: "# WebAPI contract\n\nA specification, not a shipped component.",
            },
          ],
        }),
    },
  });

  assert.deepEqual(result.paths, ["repos/_shared/webapi-contract/00-overview/sources.md"]);
  assert.match(
    readFileSync(join(kbRoot, "repos/_shared/webapi-contract/00-overview/sources.md"), "utf8"),
    /specification/,
  );
});

test("buildSharedContract tells the model this is a contract, not an install", async () => {
  const kbRoot = mkdtempSync(join(tmpdir(), "kb-contract2-"));
  let prompt = "";
  await buildSharedContract({
    kbRoot,
    workRoot: mkdtempSync(join(tmpdir(), "work-")),
    auth,
    deps: {
      clone: ({ dir }) => fakeCheckout(dir),
      callClaude: async (p) => {
        prompt = p;
        return JSON.stringify({ summary: "s", changes: [] });
      },
    },
  });
  assert.match(prompt, /contract specification/);
  assert.match(prompt, /repos\/_shared\/webapi-contract\//);
});
