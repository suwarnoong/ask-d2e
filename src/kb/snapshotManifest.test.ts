import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSnapshotFiles, rebuildSnapshotManifest } from "./snapshotManifest.js";

function makeSnapshot(): string {
  const root = mkdtempSync(join(tmpdir(), "snap-manifest-"));
  const docs = join(root, "snapshots", "develop", "docs", "2-admin_guide");
  const generated = join(root, "snapshots", "develop", "generated", "atlas3", "00-overview");
  mkdirSync(docs, { recursive: true });
  mkdirSync(generated, { recursive: true });
  writeFileSync(join(docs, "cli.md"), "# CLI\n\nRun ./d2e up.");
  writeFileSync(join(generated, "intro.md"), "# Atlas3\n\nEmbedded cohort builder.");
  writeFileSync(
    join(root, "snapshots", "develop", "troubleshooting.md"),
    "TROUBLESHOOTING INDEX\n\n### Port in use",
  );
  return root;
}

test("collectSnapshotFiles gathers docs, generated content and the troubleshooting index", () => {
  const root = makeSnapshot();
  assert.deepEqual(
    collectSnapshotFiles(root, "develop").map((f) => f.path),
    [
      "snapshots/develop/docs/2-admin_guide/cli.md",
      "snapshots/develop/generated/atlas3/00-overview/intro.md",
      "snapshots/develop/troubleshooting.md",
    ],
  );
});

test("collectSnapshotFiles returns an empty array for an unknown snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "snap-none-"));
  assert.deepEqual(collectSnapshotFiles(root, "develop"), []);
});

test("rebuildSnapshotManifest indexes generated files alongside the docs", () => {
  const root = makeSnapshot();
  const manifest = rebuildSnapshotManifest(root, "develop");

  assert.deepEqual(
    manifest.entries.map((e) => e.path),
    [
      "snapshots/develop/docs/2-admin_guide/cli.md",
      "snapshots/develop/generated/atlas3/00-overview/intro.md",
      "snapshots/develop/troubleshooting.md",
    ],
  );
  assert.equal(manifest.entries[1].title, "Atlas3");
  assert.match(manifest.entries[1].summary, /Embedded cohort builder/);

  const written = JSON.parse(readFileSync(join(root, "snapshots", "develop", "manifest.json"), "utf8"));
  assert.equal(written.snapshotId, "develop");
  assert.equal(written.entries.length, 3);
});

test("rebuildSnapshotManifest is idempotent apart from generatedAt", () => {
  const root = makeSnapshot();
  const first = rebuildSnapshotManifest(root, "develop");
  const second = rebuildSnapshotManifest(root, "develop");
  assert.deepEqual(first.entries, second.entries);
});
