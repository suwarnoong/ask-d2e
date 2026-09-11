import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTitle, buildManifest, renderManifest } from "./manifest.js";

test("extractTitle takes the first markdown heading", () => {
  assert.equal(extractTitle("# Cohort Studies\n\nSome prose."), "Cohort Studies");
  assert.equal(extractTitle("intro\n\n## Deep Dive\nmore"), "Deep Dive");
});

test("extractTitle falls back to a stable placeholder when there is no heading", () => {
  assert.equal(extractTitle("just prose, no heading"), "(untitled)");
  assert.equal(extractTitle(""), "(untitled)");
});

test("extractTitle trims trailing hashes and whitespace", () => {
  assert.equal(extractTitle("#   Spaced Out   ###"), "Spaced Out");
});

test("buildManifest records one entry per file, sorted by path", () => {
  const files = [
    { path: "b/second.md", content: "# Second" },
    { path: "a/first.md", content: "# First" },
  ];
  const manifest = buildManifest("develop", files, (f) => `summary of ${f.path}`);

  assert.equal(manifest.snapshotId, "develop");
  assert.deepEqual(
    manifest.entries.map((e) => e.path),
    ["a/first.md", "b/second.md"],
  );
  assert.deepEqual(manifest.entries[0], {
    path: "a/first.md",
    title: "First",
    summary: "summary of a/first.md",
  });
  assert.ok(!Number.isNaN(Date.parse(manifest.generatedAt)));
});

test("buildManifest does not mutate the input array", () => {
  const files = [
    { path: "b.md", content: "# B" },
    { path: "a.md", content: "# A" },
  ];
  buildManifest("develop", files, () => "s");
  assert.deepEqual(files.map((f) => f.path), ["b.md", "a.md"]);
});

test("renderManifest emits one compact line per entry under a header", () => {
  const manifest = {
    snapshotId: "v0.18.1-beta",
    generatedAt: "2026-09-11T00:00:00.000Z",
    entries: [
      { path: "docs/setup/cli.md", title: "CLI", summary: "Installing and running the d2e CLI." },
    ],
  };
  const rendered = renderManifest(manifest);

  assert.match(rendered, /KNOWLEDGE BASE INDEX \(snapshot: v0\.18\.1-beta\)/);
  assert.match(rendered, /- docs\/setup\/cli\.md — CLI: Installing and running the d2e CLI\./);
});

test("renderManifest states the file count so the model knows the search space", () => {
  const manifest = {
    snapshotId: "develop",
    generatedAt: "2026-09-11T00:00:00.000Z",
    entries: [
      { path: "a.md", title: "A", summary: "sa" },
      { path: "b.md", title: "B", summary: "sb" },
    ],
  };
  assert.match(renderManifest(manifest), /2 files/);
});
