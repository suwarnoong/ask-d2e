import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./gitOps.js";
import { loadRegistry, isDue, canAutoRefresh, withRegistryRetry, type RegistryEntry } from "./registry.js";

function makeBareOrigin(): string {
  const dir = mkdtempSync(join(tmpdir(), "reg-origin-"));
  git(dir, ["init", "--bare", "-b", "main"]);
  return dir;
}

function cloneFrom(origin: string, label: string): string {
  const parent = mkdtempSync(join(tmpdir(), `reg-clone-${label}-`));
  git(parent, ["clone", origin, "repo"]);
  return join(parent, "repo");
}

function seedOrigin(origin: string, entries: RegistryEntry[] = []): string {
  const seeder = cloneFrom(origin, "seed");
  writeFileSync(join(seeder, "repos.json"), JSON.stringify(entries, null, 2) + "\n");
  git(seeder, ["add", "repos.json"]);
  git(seeder, ["-c", "user.name=seed", "-c", "user.email=seed@example.com", "commit", "-m", "seed"]);
  git(seeder, ["push", "origin", "HEAD:main"]);
  return origin;
}

function fixtureEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    name: "acme",
    sourceRepo: "acme/widgets",
    promptSpec: { audience: "engineers", exampleQuestions: [], focusAreas: [], scopeNotes: "" },
    cadence: "weekly",
    status: "active",
    createdBy: "U1",
    createdAt: new Date().toISOString(),
    lastRefreshedAt: null,
    lastAutoRefreshAt: null,
    ...overrides,
  };
}

test("loadRegistry parses repos.json", () => {
  const origin = seedOrigin(makeBareOrigin(), [fixtureEntry()]);
  const work = cloneFrom(origin, "load");
  const entries = loadRegistry(work);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "acme");
});

test("isDue is true when never refreshed", () => {
  assert.equal(isDue(fixtureEntry({ lastRefreshedAt: null }), new Date()), true);
});

test("isDue respects daily vs weekly cadence thresholds", () => {
  const now = new Date("2026-09-10T00:00:00Z");
  const dailyJustUnder = fixtureEntry({ cadence: "daily", lastRefreshedAt: new Date(now.getTime() - 23 * 3600_000).toISOString() });
  const dailyOver = fixtureEntry({ cadence: "daily", lastRefreshedAt: new Date(now.getTime() - 25 * 3600_000).toISOString() });
  assert.equal(isDue(dailyJustUnder, now), false);
  assert.equal(isDue(dailyOver, now), true);

  const weeklyJustUnder = fixtureEntry({ cadence: "weekly", lastRefreshedAt: new Date(now.getTime() - 6 * 24 * 3600_000).toISOString() });
  const weeklyOver = fixtureEntry({ cadence: "weekly", lastRefreshedAt: new Date(now.getTime() - 8 * 24 * 3600_000).toISOString() });
  assert.equal(isDue(weeklyJustUnder, now), false);
  assert.equal(isDue(weeklyOver, now), true);
});

test("canAutoRefresh is true when never attempted, false within the 1h cooldown", () => {
  const now = new Date("2026-09-10T00:00:00Z");
  assert.equal(canAutoRefresh(fixtureEntry({ lastAutoRefreshAt: null }), now), true);
  assert.equal(canAutoRefresh(fixtureEntry({ lastAutoRefreshAt: new Date(now.getTime() - 30 * 60_000).toISOString() }), now), false);
  assert.equal(canAutoRefresh(fixtureEntry({ lastAutoRefreshAt: new Date(now.getTime() - 90 * 60_000).toISOString() }), now), true);
});

test("withRegistryRetry adds an entry for a single writer", async () => {
  const origin = seedOrigin(makeBareOrigin(), []);
  const work = cloneFrom(origin, "single");
  await withRegistryRetry(work, "main", (entries) => [...entries, fixtureEntry({ name: "new-repo" })], "add new-repo");
  const check = cloneFrom(origin, "check");
  const entries = loadRegistry(check);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "new-repo");
});

test("withRegistryRetry is a no-op when mutate returns an unchanged array", async () => {
  const origin = seedOrigin(makeBareOrigin(), [fixtureEntry()]);
  const work = cloneFrom(origin, "noop");
  const before = readFileSync(join(work, "repos.json"), "utf8");
  await withRegistryRetry(work, "main", (entries) => entries, "no-op mutate");
  const after = readFileSync(join(work, "repos.json"), "utf8");
  assert.equal(before, after);
});

test("withRegistryRetry resolves a concurrent write race — both mutations land", async () => {
  const origin = seedOrigin(makeBareOrigin(), []);
  const workA = cloneFrom(origin, "concA");
  const workB = cloneFrom(origin, "concB");

  // Writer A adds "repo-a" and pushes first.
  await withRegistryRetry(workA, "main", (entries) => [...entries, fixtureEntry({ name: "repo-a" })], "add repo-a");

  // Writer B started from the same empty base, adds "repo-b" — its first push attempt
  // will be rejected (non-fast-forward), forcing the fetch+reset+reapply retry loop.
  await withRegistryRetry(workB, "main", (entries) => [...entries, fixtureEntry({ name: "repo-b" })], "add repo-b");

  const check = cloneFrom(origin, "concCheck");
  const names = loadRegistry(check).map((e) => e.name).sort();
  assert.deepEqual(names, ["repo-a", "repo-b"]);
});
