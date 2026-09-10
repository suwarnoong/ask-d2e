import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildCloneUrl, cloneKbBundle } from "./build-kb-bundle.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeSourceRepo() {
  const dir = mkdtempSync(join(tmpdir(), "kb-bundle-source-"));
  git(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "repos.json"), "[]\n");
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.name=s", "-c", "user.email=s@example.com", "commit", "-m", "seed"]);
  return dir;
}

test("buildCloneUrl embeds the token as an x-access-token basic-auth credential", () => {
  const url = buildCloneUrl("suwarnoong/ask-d2e-kb", "ghp_secret123");
  assert.equal(url, "https://x-access-token:ghp_secret123@github.com/suwarnoong/ask-d2e-kb.git");
});

test("cloneKbBundle clones the branch into targetDir", () => {
  const source = makeSourceRepo();
  const parent = mkdtempSync(join(tmpdir(), "kb-bundle-target-"));
  const targetDir = join(parent, "knowledge-base");

  cloneKbBundle({ url: source, branch: "main", targetDir });

  assert.equal(existsSync(join(targetDir, "repos.json")), true);
  assert.equal(readFileSync(join(targetDir, "repos.json"), "utf8"), "[]\n");
});

test("cloneKbBundle overwrites a pre-existing targetDir", () => {
  const source = makeSourceRepo();
  const parent = mkdtempSync(join(tmpdir(), "kb-bundle-target2-"));
  const targetDir = join(parent, "knowledge-base");
  writeFileSync(join(parent, "knowledge-base"), "not a directory", { flag: "wx" });

  // targetDir currently exists as a plain file, not a directory — cloneKbBundle must remove it first.
  cloneKbBundle({ url: source, branch: "main", targetDir });

  assert.equal(existsSync(join(targetDir, "repos.json")), true);
});

test("cloneKbBundle throws loudly on an unreachable repo", () => {
  const parent = mkdtempSync(join(tmpdir(), "kb-bundle-badurl-"));
  const targetDir = join(parent, "knowledge-base");
  assert.throws(() => cloneKbBundle({ url: "/definitely/not/a/real/repo/path", branch: "main", targetDir }));
});
