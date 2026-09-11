import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./gitOps.js";
import { runRefresh, summarize, type RefreshConfig, type RefreshDeps } from "./refresh.js";
import { loadRegistry, type RegistryEntry } from "./registry.js";
import type { DigestData } from "../shared/githubDiff.js";

const NOW = new Date("2026-09-11T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function fixtureEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    name: "widgets",
    sourceRepo: "acme/widgets",
    promptSpec: { audience: "engineers", exampleQuestions: [], focusAreas: [], scopeNotes: "" },
    cadence: "daily",
    status: "active",
    createdBy: "U1",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastRefreshedAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
    lastAutoRefreshAt: null,
    ...overrides,
  };
}

/** A bare origin plus a working clone seeded with repos.json and one KB page per entry. */
function makeKbRepo(entries: RegistryEntry[]): string {
  const origin = mkdtempSync(join(tmpdir(), "refresh-origin-"));
  git(origin, ["init", "--bare", "-b", "main"]);

  const seedParent = mkdtempSync(join(tmpdir(), "refresh-seed-"));
  git(seedParent, ["clone", origin, "repo"]);
  const seed = join(seedParent, "repo");
  writeFileSync(join(seed, "repos.json"), JSON.stringify(entries, null, 2) + "\n");
  for (const e of entries) {
    const dir = join(seed, "repos", e.name, "knowledge-base", "00-overview");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "intro.md"), "# Intro\n\nOld content.\n");
  }
  git(seed, ["add", "-A"]);
  git(seed, ["-c", "user.name=seed", "-c", "user.email=seed@example.com", "commit", "-m", "seed"]);
  git(seed, ["push", "origin", "HEAD:main"]);

  const workParent = mkdtempSync(join(tmpdir(), "refresh-work-"));
  git(workParent, ["clone", origin, "kb"]);
  return join(workParent, "kb");
}

function config(kbRoot: string, overrides: Partial<RefreshConfig> = {}): RefreshConfig {
  return {
    claudeOauthToken: "tok",
    claudeModel: "claude-sonnet-4-5",
    kbRepoToken: "kbtok",
    sourceReposToken: "srctok",
    kbTargetBranch: "main",
    dryRun: false,
    skipIfEmpty: true,
    kbRoot,
    workDir: mkdtempSync(join(tmpdir(), "refresh-src-")),
    deployHookUrl: "",
    ...overrides,
  };
}

function digest(prCount: number, since = "2026-09-09T00:00:00.000Z"): DigestData {
  return {
    repo: "acme/widgets",
    since,
    generatedAt: NOW.toISOString(),
    prs: [],
    byAuthor: [],
    totals: { prCount, authorCount: prCount ? 1 : 0, additions: 0, deletions: 0 },
  };
}

function planJson(paths: string[]): string {
  return JSON.stringify({
    summary: "Updated docs",
    changes: paths.map((path) => ({
      path,
      action: "update",
      rationale: "PR changed it",
      source_prs: [42],
      content: "# Intro\n\nNew content.\n",
    })),
  });
}

/** Sensible no-op deps; each test overrides only what it cares about. */
function deps(overrides: Partial<RefreshDeps> = {}): Partial<RefreshDeps> {
  return {
    now: NOW,
    cloneSourceRepo: () => {},
    notify: async () => {},
    gatherRepoPrs: async () => digest(1),
    callClaude: async () => planJson(["repos/widgets/knowledge-base/00-overview/intro.md"]),
    ...overrides,
  };
}

test("exits without calling Claude when nothing is due", async () => {
  const kbRoot = makeKbRepo([fixtureEntry({ cadence: "weekly" })]); // refreshed 2 days ago
  let called = false;
  await runRefresh(config(kbRoot), deps({ callClaude: async () => { called = true; return planJson([]); } }));
  assert.equal(called, false);
});

test("ignores entries still pending their initial build", async () => {
  const kbRoot = makeKbRepo([fixtureEntry({ status: "pending-initial-build", lastRefreshedAt: null })]);
  let called = false;
  await runRefresh(config(kbRoot), deps({ gatherRepoPrs: async () => { called = true; return digest(0); } }));
  assert.equal(called, false);
});

test("skips a due repo with no merged PRs and leaves lastRefreshedAt untouched", async () => {
  const entry = fixtureEntry();
  const kbRoot = makeKbRepo([entry]);
  let claudeCalls = 0;
  await runRefresh(config(kbRoot), deps({
    gatherRepoPrs: async () => digest(0),
    callClaude: async () => { claudeCalls++; return planJson([]); },
  }));
  assert.equal(claudeCalls, 0);
  assert.equal(loadRegistry(kbRoot)[0].lastRefreshedAt, entry.lastRefreshedAt);
});

test("processes a due repo: writes the page, commits it, and bumps lastRefreshedAt", async () => {
  const kbRoot = makeKbRepo([fixtureEntry()]);
  await runRefresh(config(kbRoot), deps());

  const page = readFileSync(join(kbRoot, "repos/widgets/knowledge-base/00-overview/intro.md"), "utf8");
  assert.match(page, /New content/);
  assert.equal(loadRegistry(kbRoot)[0].lastRefreshedAt, NOW.toISOString());
  // Both the markdown commit and the registry bump must have reached the origin.
  assert.equal(git(kbRoot, ["status", "--porcelain"]), "");
  const log = git(kbRoot, ["log", "origin/main", "--format=%s"]);
  assert.match(log, /docs\(kb\): scheduled refresh for widgets/);
  assert.match(log, /chore\(kb\): bump lastRefreshedAt for widgets/);
});

test("an empty-changes plan is still a successful refresh — lastRefreshedAt advances", async () => {
  const kbRoot = makeKbRepo([fixtureEntry()]);
  await runRefresh(config(kbRoot), deps({ callClaude: async () => planJson([]) }));
  assert.equal(loadRegistry(kbRoot)[0].lastRefreshedAt, NOW.toISOString());
  assert.match(readFileSync(join(kbRoot, "repos/widgets/knowledge-base/00-overview/intro.md"), "utf8"), /Old content/);
});

test("a null lastRefreshedAt falls back to a cadence-width PR window", async () => {
  const kbRoot = makeKbRepo([fixtureEntry({ lastRefreshedAt: null, cadence: "weekly" })]);
  let since = "";
  await runRefresh(config(kbRoot), deps({
    gatherRepoPrs: async (_repo, sinceIso) => { since = sinceIso; return digest(0); },
  }));
  assert.equal(since, new Date(NOW.getTime() - 7 * DAY).toISOString());
});

test("an existing lastRefreshedAt is used verbatim as the PR window start", async () => {
  const entry = fixtureEntry();
  const kbRoot = makeKbRepo([entry]);
  let since = "";
  await runRefresh(config(kbRoot), deps({
    gatherRepoPrs: async (_repo, sinceIso) => { since = sinceIso; return digest(0); },
  }));
  assert.equal(since, entry.lastRefreshedAt);
});

test("processes several due repos in one commit and bumps both entries", async () => {
  const kbRoot = makeKbRepo([fixtureEntry(), fixtureEntry({ name: "gadgets", sourceRepo: "acme/gadgets" })]);
  await runRefresh(config(kbRoot), deps({
    callClaude: async (prompt) => planJson([
      prompt.includes("acme/gadgets")
        ? "repos/gadgets/knowledge-base/00-overview/intro.md"
        : "repos/widgets/knowledge-base/00-overview/intro.md",
    ]),
  }));

  const registry = loadRegistry(kbRoot);
  assert.deepEqual(registry.map((e) => e.lastRefreshedAt), [NOW.toISOString(), NOW.toISOString()]);
  const subjects = git(kbRoot, ["log", "origin/main", "--format=%s"]).split("\n");
  assert.equal(subjects.filter((s) => s.startsWith("docs(kb): scheduled refresh")).length, 1);
});

test("dry run writes files locally but never commits or bumps the registry", async () => {
  const entry = fixtureEntry();
  const kbRoot = makeKbRepo([entry]);
  await runRefresh(config(kbRoot, { dryRun: true }), deps());

  assert.equal(loadRegistry(kbRoot)[0].lastRefreshedAt, entry.lastRefreshedAt);
  assert.notEqual(git(kbRoot, ["status", "--porcelain"]), "");
});

test("skipIfEmpty=false processes a repo with zero merged PRs", async () => {
  const kbRoot = makeKbRepo([fixtureEntry()]);
  await runRefresh(config(kbRoot, { skipIfEmpty: false }), deps({ gatherRepoPrs: async () => digest(0) }));
  assert.equal(loadRegistry(kbRoot)[0].lastRefreshedAt, NOW.toISOString());
});

test("clones each processed repo into its own scratch dir under workDir", async () => {
  const kbRoot = makeKbRepo([fixtureEntry()]);
  const cfg = config(kbRoot);
  let dest = "";
  await runRefresh(cfg, deps({ cloneSourceRepo: (_repo, _token, d) => { dest = d; } }));
  assert.equal(dest, join(cfg.workDir, "widgets"));
});

test("notifies once with a per-repo change count", async () => {
  const kbRoot = makeKbRepo([fixtureEntry()]);
  const messages: string[] = [];
  await runRefresh(config(kbRoot), deps({ notify: async (t) => { messages.push(t); } }));
  assert.equal(messages.length, 1);
  assert.match(messages[0], /widgets.*1 merged PR\(s\), 1 page\(s\) updated/);
});

test("summarize reports 'no changes needed' for an empty plan", () => {
  const text = summarize([{ entry: fixtureEntry(), plan: { summary: "", changes: [] }, prCount: 3 }]);
  assert.match(text, /widgets.*3 merged PR\(s\), no changes needed/);
});

test("refuses a plan whose path escapes the repo's KB folder", async () => {
  const kbRoot = makeKbRepo([fixtureEntry()]);
  await assert.rejects(
    runRefresh(config(kbRoot), deps({ callClaude: async () => planJson(["repos/other/knowledge-base/x.md"]) })),
    /Refusing to write outside/,
  );
  assert.equal(existsSync(join(kbRoot, "repos/other")), false);
});
