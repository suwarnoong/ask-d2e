import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./gitOps.js";
import { loadRegistry } from "./registry.js";
import { runInitialBuild, type InitialBuildConfig } from "./initialBuild.js";

function makeBareOrigin(): string {
  const dir = mkdtempSync(join(tmpdir(), "ib-origin-"));
  git(dir, ["init", "--bare", "-b", "main"]);
  return dir;
}

function seedAndClone(origin: string): string {
  const seeder = mkdtempSync(join(tmpdir(), "ib-seed-"));
  git(seeder, ["clone", origin, "repo"]);
  const seederRepo = join(seeder, "repo");
  writeFileSync(join(seederRepo, "repos.json"), "[]\n");
  git(seederRepo, ["add", "repos.json"]);
  git(seederRepo, ["-c", "user.name=s", "-c", "user.email=s@example.com", "commit", "-m", "seed"]);
  git(seederRepo, ["push", "origin", "HEAD:main"]);

  const work = mkdtempSync(join(tmpdir(), "ib-work-"));
  git(work, ["clone", origin, "repo"]);
  return join(work, "repo");
}

function makeSourceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ib-source-"));
  git(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), "# Widgets\nA small repo.");
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.name=s", "-c", "user.email=s@example.com", "commit", "-m", "init"]);
  return dir;
}

test("runInitialBuild in dry-run mode writes nothing and makes no commits", async () => {
  const kbRoot = seedAndClone(makeBareOrigin());
  const sourceDir = makeSourceDir();
  const config: InitialBuildConfig = {
    claudeOauthToken: "tok",
    claudeModel: "m",
    kbRepoToken: "x",
    sourceReposToken: "x",
    kbTargetBranch: "main",
    dryRun: true,
    repoName: "acme",
    sourceRepo: "acme/widgets",
    promptSpecJson: JSON.stringify({ audience: "eng", exampleQuestions: [], focusAreas: [], scopeNotes: "" }),
    cadence: "weekly",
    createdBy: "U1",
    kbRoot,
    sourceDir,
  };

  const stubClaude = async () =>
    JSON.stringify({
      summary: "initial build",
      changes: [{ path: "repos/acme/knowledge-base/00-overview/intro.md", action: "create", rationale: "r", source_prs: [], content: "hello" }],
    });
  const stubPostMessage = async () => {};

  await runInitialBuild(config, { callClaude: stubClaude, postMessage: stubPostMessage });

  const registry = loadRegistry(kbRoot);
  assert.equal(registry.length, 0, "dry run must not mutate the registry");
});

test("runInitialBuild (real run) applies changes, updates the registry, and commits", async () => {
  const kbRoot = seedAndClone(makeBareOrigin());
  const sourceDir = makeSourceDir();
  const config: InitialBuildConfig = {
    claudeOauthToken: "tok",
    claudeModel: "m",
    kbRepoToken: "x",
    sourceReposToken: "x",
    kbTargetBranch: "main",
    dryRun: false,
    repoName: "acme",
    sourceRepo: "acme/widgets",
    promptSpecJson: JSON.stringify({ audience: "eng", exampleQuestions: [], focusAreas: [], scopeNotes: "" }),
    cadence: "weekly",
    createdBy: "U1",
    kbRoot,
    sourceDir,
  };

  const stubClaude = async () =>
    JSON.stringify({
      summary: "initial build",
      changes: [{ path: "repos/acme/knowledge-base/00-overview/intro.md", action: "create", rationale: "r", source_prs: [], content: "hello" }],
    });
  let notified = false;
  const stubPostMessage = async () => { notified = true; };
  const stubOpenDm = async () => "D1";

  process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
  try {
    await runInitialBuild(config, { callClaude: stubClaude, postMessage: stubPostMessage, openDm: stubOpenDm });
  } finally {
    delete process.env.SLACK_BOT_TOKEN;
  }

  const content = readFileSync(join(kbRoot, "repos", "acme", "knowledge-base", "00-overview", "intro.md"), "utf8");
  assert.equal(content, "hello\n");
  const registry = loadRegistry(kbRoot);
  assert.equal(registry.length, 1);
  assert.equal(registry[0].name, "acme");
  assert.equal(registry[0].status, "active");
  assert.ok(notified);
});
