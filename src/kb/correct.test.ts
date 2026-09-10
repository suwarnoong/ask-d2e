import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./gitOps.js";
import { runCorrect, type CorrectConfig } from "./correct.js";

function makeBareOrigin(): string {
  const dir = mkdtempSync(join(tmpdir(), "correct-origin-"));
  git(dir, ["init", "--bare", "-b", "main"]);
  return dir;
}

function seedAndClone(origin: string): string {
  const seeder = mkdtempSync(join(tmpdir(), "correct-seed-"));
  git(seeder, ["clone", origin, "repo"]);
  const seederRepo = join(seeder, "repo");
  const entry = {
    name: "acme", sourceRepo: "acme/widgets",
    promptSpec: { audience: "eng", exampleQuestions: [], focusAreas: [], scopeNotes: "" },
    cadence: "weekly", status: "active", createdBy: "U1", createdAt: "2026-01-01T00:00:00Z",
    lastRefreshedAt: "2026-01-01T00:00:00Z", lastAutoRefreshAt: null,
  };
  mkdirSync(join(seederRepo, "repos", "acme", "knowledge-base"), { recursive: true });
  writeFileSync(join(seederRepo, "repos.json"), JSON.stringify([entry], null, 2) + "\n");
  git(seederRepo, ["add", "."]);
  git(seederRepo, ["-c", "user.name=s", "-c", "user.email=s@example.com", "commit", "-m", "seed"]);
  git(seederRepo, ["push", "origin", "HEAD:main"]);

  const work = mkdtempSync(join(tmpdir(), "correct-work-"));
  git(work, ["clone", origin, "repo"]);
  return join(work, "repo");
}

function makeSourceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "correct-source-"));
  git(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), "# Widgets");
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.name=s", "-c", "user.email=s@example.com", "commit", "-m", "init"]);
  return dir;
}

function baseConfig(kbRoot: string, sourceDir: string, mode: "fix" | "gap-fill"): CorrectConfig {
  return {
    claudeOauthToken: "tok", claudeModel: "m",
    kbRepoToken: "x", sourceReposToken: "x", kbTargetBranch: "main", dryRun: false,
    mode, repoName: "acme", question: "how does X work?", answer: "prior answer",
    askedBy: "U1", slackChannel: "", slackThreadTs: "",
    kbRoot, sourceDir,
  };
}

test("runCorrect with empty changes (mode fix) posts a reviewed-no-change notice and writes nothing", async () => {
  const kbRoot = seedAndClone(makeBareOrigin());
  const sourceDir = makeSourceDir();
  let notified = "";
  const stubClaude = async () => JSON.stringify({ summary: "no issue found", changes: [] });
  const stubNotify = async (text: string) => { notified = text; };

  await runCorrect(baseConfig(kbRoot, sourceDir, "fix"), { callClaude: stubClaude, notify: stubNotify });

  assert.match(notified, /reviewed, no change needed/i);
  assert.equal(existsSync(join(kbRoot, "repos", "acme", "knowledge-base", "x.md")), false);
});

test("runCorrect with real changes (mode fix) writes and commits with the fix subject", async () => {
  const kbRoot = seedAndClone(makeBareOrigin());
  const sourceDir = makeSourceDir();
  const stubClaude = async () =>
    JSON.stringify({ summary: "corrected", changes: [{ path: "repos/acme/knowledge-base/x.md", action: "create", rationale: "r", source_prs: [], content: "fixed" }] });
  const stubNotify = async () => {};

  await runCorrect(baseConfig(kbRoot, sourceDir, "fix"), { callClaude: stubClaude, notify: stubNotify });

  const log = git(kbRoot, ["log", "-1", "--pretty=%s"]);
  assert.match(log, /correct answer flagged in Slack/);
});

test("runCorrect with empty changes (mode gap-fill) posts a still-not-covered notice", async () => {
  const kbRoot = seedAndClone(makeBareOrigin());
  const sourceDir = makeSourceDir();
  let notified = "";
  const stubClaude = async () => JSON.stringify({ summary: "out of scope", changes: [] });
  const stubNotify = async (text: string) => { notified = text; };

  await runCorrect(baseConfig(kbRoot, sourceDir, "gap-fill"), { callClaude: stubClaude, notify: stubNotify });

  assert.match(notified, /still not covered|not covered/i);
});
