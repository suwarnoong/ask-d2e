import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, commitAndPush, pushWithRebase } from "./gitOps.js";

function makeBareOrigin(): string {
  const dir = mkdtempSync(join(tmpdir(), "kb-origin-"));
  git(dir, ["init", "--bare", "-b", "main"]);
  return dir;
}

function cloneFrom(origin: string, label: string): string {
  const parent = mkdtempSync(join(tmpdir(), `kb-clone-${label}-`));
  const dir = join(parent, "repo");
  git(parent, ["clone", origin, "repo"]);
  git(dir, ["-c", "user.name=test", "-c", "user.email=test@example.com", "config", "user.name", "test"]);
  return dir;
}

function seedOrigin(origin: string): string {
  const seeder = cloneFrom(origin, "seed");
  writeFileSync(join(seeder, "repos.json"), "[]\n");
  git(seeder, ["add", "repos.json"]);
  git(seeder, ["-c", "user.name=seed", "-c", "user.email=seed@example.com", "commit", "-m", "seed"]);
  git(seeder, ["push", "origin", "HEAD:main"]);
  return origin;
}

test("commitAndPush is a no-op when nothing changed", () => {
  const origin = seedOrigin(makeBareOrigin());
  const work = cloneFrom(origin, "noop");
  const pushed = commitAndPush(work, { summary: "s", changes: [] }, "acme", "main");
  assert.equal(pushed, false);
});

test("commitAndPush commits and pushes a real change", () => {
  const origin = seedOrigin(makeBareOrigin());
  const work = cloneFrom(origin, "real");
  mkdirSync(join(work, "repos", "acme", "knowledge-base"), { recursive: true });
  writeFileSync(join(work, "repos", "acme", "knowledge-base", "x.md"), "content\n");
  const pushed = commitAndPush(
    work,
    { summary: "add x", changes: [{ path: "repos/acme/knowledge-base/x.md", action: "create", rationale: "r", source_prs: [], content: "content" }] },
    "acme",
    "main",
  );
  assert.equal(pushed, true);
  const log = git(work, ["log", "-1", "--pretty=%s"]);
  assert.match(log, /docs\(kb\): update acme/);
});

test("pushWithRebase resolves a push race via fetch+rebase+retry", () => {
  const origin = seedOrigin(makeBareOrigin());
  const workA = cloneFrom(origin, "a");
  const workB = cloneFrom(origin, "b");

  mkdirSync(join(workA, "repos", "acme", "knowledge-base"), { recursive: true });
  writeFileSync(join(workA, "repos", "acme", "knowledge-base", "a.md"), "from a\n");
  git(workA, ["add", "."]);
  git(workA, ["-c", "user.name=a", "-c", "user.email=a@example.com", "commit", "-m", "from a"]);
  git(workA, ["push", "origin", "HEAD:main"]);

  mkdirSync(join(workB, "repos", "other", "knowledge-base"), { recursive: true });
  writeFileSync(join(workB, "repos", "other", "knowledge-base", "b.md"), "from b\n");
  git(workB, ["add", "."]);
  git(workB, ["-c", "user.name=b", "-c", "user.email=b@example.com", "commit", "-m", "from b"]);

  pushWithRebase(workB, "main");

  const finalClone = cloneFrom(origin, "final");
  const log = git(finalClone, ["log", "--oneline"]);
  assert.match(log, /from a/);
  assert.match(log, /from b/);
});
