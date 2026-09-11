import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bodyExcerpt,
  buildPrDiff,
  groupByAuthor,
  splitRepo,
  gatherRepoPrs,
  type GithubClient,
  type RawPr,
  type RawPrFile,
  type PrSummary,
} from "./githubDiff.js";

function rawPr(overrides: Partial<RawPr> = {}): RawPr {
  return {
    number: 1,
    title: "Add widget",
    user: { login: "alice" },
    html_url: "https://github.com/acme/widgets/pull/1",
    additions: 10,
    deletions: 2,
    changed_files: 1,
    labels: [{ name: "feature" }],
    body: "Adds a widget.",
    merged_at: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

function file(overrides: Partial<RawPrFile> = {}): RawPrFile {
  return { filename: "src/a.ts", status: "modified", additions: 5, deletions: 1, patch: "@@ -1 +1 @@", ...overrides };
}

function stubClient(prs: RawPr[], filesByPr: Record<number, RawPrFile[]> = {}): GithubClient {
  return {
    async searchMergedPrNumbers() {
      return prs.map((p) => p.number);
    },
    async getPr(_repo, prNumber) {
      return prs.find((p) => p.number === prNumber)!;
    },
    async listPrFiles(_repo, prNumber) {
      return filesByPr[prNumber] ?? [file()];
    },
  };
}

test("splitRepo rejects anything that isn't owner/name", () => {
  assert.deepEqual(splitRepo("acme/widgets"), ["acme", "widgets"]);
  assert.throws(() => splitRepo("widgets"), /owner\/name/);
});

test("bodyExcerpt strips HTML comments, collapses whitespace, and caps length", () => {
  assert.equal(bodyExcerpt("<!-- template -->\nHello\r\n  world"), "Hello world");
  const long = bodyExcerpt("x".repeat(400));
  assert.equal(long.length, 281);
  assert.ok(long.endsWith("…"));
});

test("bodyExcerpt handles a null body", () => {
  assert.equal(bodyExcerpt(null), "");
});

test("buildPrDiff emits a header block per file and reports no truncation under the cap", () => {
  const { diff, truncated } = buildPrDiff([file(), file({ filename: "src/b.ts", status: "added" })]);
  assert.equal(truncated, false);
  assert.match(diff, /### modified src\/a\.ts \(\+5\/-1\)/);
  assert.match(diff, /### added src\/b\.ts/);
});

test("buildPrDiff notes a binary file with no patch", () => {
  const { diff } = buildPrDiff([file({ patch: undefined })]);
  assert.match(diff, /\(binary file or no patch available\)/);
});

test("buildPrDiff truncates at the cap and flags how many files were dropped", () => {
  const big = file({ patch: "x".repeat(60) });
  const { diff, truncated } = buildPrDiff([big, big, big, big], 100);
  assert.equal(truncated, true);
  assert.match(diff, /and 3 more file\(s\) not shown \(diff size cap reached\)/);
});

test("groupByAuthor sorts by PR count, then by total churn", () => {
  const prs = [
    { author: "alice", number: 1, additions: 1, deletions: 1 },
    { author: "bob", number: 2, additions: 100, deletions: 100 },
    { author: "bob", number: 3, additions: 1, deletions: 1 },
    { author: "carol", number: 4, additions: 50, deletions: 50 },
  ] as PrSummary[];
  const groups = groupByAuthor(prs);
  assert.deepEqual(groups.map((g) => g.author), ["bob", "carol", "alice"]);
  assert.equal(groups[0].prCount, 2);
  assert.deepEqual(groups[0].prs, [2, 3]);
});

test("gatherRepoPrs assembles totals and per-PR summaries", async () => {
  const client = stubClient([rawPr(), rawPr({ number: 2, user: { login: "bob" }, additions: 4, deletions: 3 })]);
  const data = await gatherRepoPrs("acme/widgets", "2026-09-01T00:00:00.000Z", "tok", client);

  assert.equal(data.repo, "acme/widgets");
  assert.equal(data.totals.prCount, 2);
  assert.equal(data.totals.authorCount, 2);
  assert.equal(data.totals.additions, 14);
  assert.equal(data.totals.deletions, 5);
  assert.deepEqual(data.prs[0].labels, ["feature"]);
  assert.deepEqual(data.prs[0].files, ["src/a.ts"]);
});

test("gatherRepoPrs drops PRs merged before `since` (search granularity is only per-day)", async () => {
  const client = stubClient([
    rawPr({ number: 1, merged_at: "2026-08-30T00:00:00.000Z" }),
    rawPr({ number: 2, merged_at: "2026-09-02T00:00:00.000Z" }),
  ]);
  const data = await gatherRepoPrs("acme/widgets", "2026-09-01T00:00:00.000Z", "tok", client);
  assert.deepEqual(data.prs.map((p) => p.number), [2]);
});

test("gatherRepoPrs falls back to 'unknown' for a PR with no author", async () => {
  const data = await gatherRepoPrs("acme/widgets", "2026-09-01T00:00:00.000Z", "tok", stubClient([rawPr({ user: null })]));
  assert.equal(data.prs[0].author, "unknown");
});

test("gatherRepoPrs returns empty totals when nothing merged in the window", async () => {
  const data = await gatherRepoPrs("acme/widgets", "2026-09-01T00:00:00.000Z", "tok", stubClient([]));
  assert.equal(data.totals.prCount, 0);
  assert.deepEqual(data.prs, []);
});
