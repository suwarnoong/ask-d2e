import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summariseDoc, buildDocsTier } from "./buildDocsTier.js";

function makeDocsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "docsroot-"));
  mkdirSync(join(root, "2-admin_guide", "5-setup"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Getting started\n\nWelcome to Data2Evidence.");
  writeFileSync(
    join(root, "2-admin_guide", "5-setup", "cli.md"),
    [
      "---",
      "title: The CLI",
      "---",
      "",
      "# CLI",
      "",
      "Run ./d2e up to start the stack.",
      "",
      "## Troubleshooting",
      "",
      "### Port 8001 already in use",
      "",
      "**Cause:** Another process holds the port.",
      "",
      "**Resolution:** Stop it or change the port.",
    ].join("\n"),
  );
  return root;
}

test("summariseDoc uses the first real prose line, not the heading or provenance", () => {
  const doc = {
    outPath: "a.md",
    sourcePath: "a.md",
    title: "A",
    content: "<!-- source: docs/website/docs/a.md -->\n\n# A\n\nThe actual summary line.\n",
  };
  assert.equal(summariseDoc(doc), "The actual summary line.");
});

test("summariseDoc truncates long lines", () => {
  const doc = {
    outPath: "a.md",
    sourcePath: "a.md",
    title: "A",
    content: `# A\n\n${"x".repeat(300)}\n`,
  };
  const summary = summariseDoc(doc);
  assert.ok(summary.length <= 163, `got ${summary.length}`);
  assert.match(summary, /…$/);
});

test("summariseDoc falls back to the title when there is no prose", () => {
  assert.equal(summariseDoc({ outPath: "a.md", sourcePath: "a.md", title: "A", content: "# A\n" }), "A");
});

test("buildDocsTier writes docs, the troubleshooting index and a manifest", () => {
  const docsRoot = makeDocsRoot();
  const kbRoot = mkdtempSync(join(tmpdir(), "kbout-"));

  const result = buildDocsTier({ docsRoot, kbRoot, snapshotId: "develop" });

  assert.equal(result.docsWritten, 2);
  assert.equal(result.troubleshootingEntries, 1);
  assert.equal(result.manifestEntries, 3); // 2 docs + troubleshooting.md

  const cliPath = join(kbRoot, "snapshots", "develop", "docs", "2-admin_guide", "5-setup", "cli.md");
  assert.ok(existsSync(cliPath));
  assert.match(readFileSync(cliPath, "utf8"), /Run \.\/d2e up/);

  assert.ok(existsSync(join(kbRoot, "snapshots", "develop", "docs", "index.md")));
  assert.match(
    readFileSync(join(kbRoot, "snapshots", "develop", "troubleshooting.md"), "utf8"),
    /Port 8001 already in use/,
  );
});

test("buildDocsTier's manifest paths are the paths the retrieval tools accept", () => {
  const docsRoot = makeDocsRoot();
  const kbRoot = mkdtempSync(join(tmpdir(), "kbout2-"));
  buildDocsTier({ docsRoot, kbRoot, snapshotId: "develop" });

  const manifest = JSON.parse(
    readFileSync(join(kbRoot, "snapshots", "develop", "manifest.json"), "utf8"),
  );

  assert.equal(manifest.snapshotId, "develop");
  for (const entry of manifest.entries) {
    assert.match(entry.path, /^snapshots\/develop\//, `bad manifest path: ${entry.path}`);
    assert.ok(existsSync(join(kbRoot, entry.path)), `manifest lists a missing file: ${entry.path}`);
  }
});

test("buildDocsTier on an absent docs root writes nothing and reports zero", () => {
  const kbRoot = mkdtempSync(join(tmpdir(), "kbout3-"));
  const result = buildDocsTier({
    docsRoot: join(tmpdir(), "definitely-not-here-98765"),
    kbRoot,
    snapshotId: "develop",
  });

  assert.equal(result.docsWritten, 0);
  assert.equal(result.manifestEntries, 0);
  assert.equal(existsSync(join(kbRoot, "snapshots", "develop", "manifest.json")), false);
});
