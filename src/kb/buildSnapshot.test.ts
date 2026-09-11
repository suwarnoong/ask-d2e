import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSnapshot, readPinSources } from "./buildSnapshot.js";
import { loadSnapshotRegistry, writeSnapshotRegistry } from "./snapshots.js";

const ATLAS = JSON.stringify({ dependencies: { "@ohdsi/atlas3": "0.1.0-20260817035540-9baa99a" } });
const TREX =
  "FROM ghcr.io/ohdsi/trexsql:sha-dec4a9508dcc57597c64422d6a27a36daaf74e27@sha256:d7922fb4 AS base";

function makeD2eCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), "d2e-checkout-"));
  mkdirSync(join(root, "plugins", "atlas"), { recursive: true });
  mkdirSync(join(root, "services", "trex"), { recursive: true });
  mkdirSync(join(root, "docs", "website", "docs", "2-admin_guide"), { recursive: true });
  writeFileSync(join(root, "plugins", "atlas", "package.json"), ATLAS);
  writeFileSync(join(root, "services", "trex", "Dockerfile.v2"), TREX);
  writeFileSync(
    join(root, "docs", "website", "docs", "2-admin_guide", "cli.md"),
    [
      "# CLI",
      "",
      "Run ./d2e up.",
      "",
      "## Troubleshooting",
      "",
      "### Port in use",
      "",
      "**Resolution:** Stop it.",
    ].join("\n"),
  );
  return root;
}

test("readPinSources reads both pin files and the docs root from a checkout", () => {
  const checkout = makeD2eCheckout();
  const sources = readPinSources(checkout);
  assert.match(sources.atlasPackageJson, /@ohdsi\/atlas3/);
  assert.match(sources.trexDockerfile, /trexsql/);
  assert.equal(sources.docsRoot, join(checkout, "docs", "website", "docs"));
});

test("buildSnapshot writes the docs tier and registers the snapshot", () => {
  const kbRoot = mkdtempSync(join(tmpdir(), "kb-snap-"));
  const checkout = makeD2eCheckout();

  const result = buildSnapshot({
    kbRoot,
    snapshotId: "v0.18.1-beta",
    d2eTag: "v0.18.1-beta",
    isDevelop: false,
    builtAt: "2026-09-11T00:00:00.000Z",
    ...readPinSources(checkout),
  });

  assert.deepEqual(result.entry.pins, { atlas3: "9baa99a", trex: "dec4a95" });
  assert.equal(result.docsWritten, 1);
  assert.equal(result.troubleshootingEntries, 1);
  assert.ok(existsSync(join(kbRoot, "snapshots", "v0.18.1-beta", "manifest.json")));
  assert.deepEqual(
    loadSnapshotRegistry(kbRoot).snapshots.map((s) => s.id),
    ["v0.18.1-beta"],
  );
});

test("a missing pin aborts before any write, leaving snapshots.json untouched", () => {
  const kbRoot = mkdtempSync(join(tmpdir(), "kb-nopin-"));
  writeSnapshotRegistry(kbRoot, {
    snapshots: [
      {
        id: "develop",
        d2eTag: "develop",
        pins: { atlas3: "269a00a", trex: "5ce4275" },
        status: "active",
        builtAt: "2026-09-11T00:00:00.000Z",
        isDevelop: true,
      },
    ],
  });
  const before = readFileSync(join(kbRoot, "snapshots.json"), "utf8");
  const checkout = makeD2eCheckout();

  assert.throws(() =>
    buildSnapshot({
      kbRoot,
      snapshotId: "v0.16.0-beta",
      d2eTag: "v0.16.0-beta",
      isDevelop: false,
      atlasPackageJson: JSON.stringify({ dependencies: { react: "^18" } }),
      trexDockerfile: TREX,
      docsRoot: join(checkout, "docs", "website", "docs"),
    }),
  );

  assert.equal(readFileSync(join(kbRoot, "snapshots.json"), "utf8"), before);
  assert.equal(existsSync(join(kbRoot, "snapshots", "v0.16.0-beta")), false);
});

test("a checkout with no docs aborts rather than registering an empty snapshot", () => {
  const kbRoot = mkdtempSync(join(tmpdir(), "kb-nodocs-"));
  assert.throws(
    () =>
      buildSnapshot({
        kbRoot,
        snapshotId: "v0.18.1-beta",
        d2eTag: "v0.18.1-beta",
        isDevelop: false,
        atlasPackageJson: ATLAS,
        trexDockerfile: TREX,
        docsRoot: join(tmpdir(), "definitely-not-here-54321"),
      }),
    /no documentation/i,
  );
  assert.equal(existsSync(join(kbRoot, "snapshots.json")), false);
});
