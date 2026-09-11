import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_ACTIVE_RELEASES,
  emptyRegistry,
  parseSnapshotRegistry,
  loadSnapshotRegistry,
  writeSnapshotRegistry,
  supportedSnapshotIds,
  registerSnapshot,
  type SnapshotEntry,
} from "./snapshots.js";

function entry(overrides: Partial<SnapshotEntry> = {}): SnapshotEntry {
  return {
    id: "v0.18.1-beta",
    d2eTag: "v0.18.1-beta",
    pins: { atlas3: "9baa99a", trex: "dec4a95" },
    status: "active",
    builtAt: "2026-09-11T00:00:00.000Z",
    isDevelop: false,
    ...overrides,
  };
}

test("parseSnapshotRegistry round-trips a registry", () => {
  const registry = { snapshots: [entry({ id: "develop", d2eTag: "develop", isDevelop: true })] };
  assert.deepEqual(parseSnapshotRegistry(JSON.stringify(registry)), registry);
});

test("parseSnapshotRegistry throws on an entry missing required fields", () => {
  assert.throws(
    () => parseSnapshotRegistry(JSON.stringify({ snapshots: [{ id: "x" }] })),
    /Invalid snapshots\.json/,
  );
});

test("parseSnapshotRegistry throws on an unknown status", () => {
  const raw = JSON.stringify({ snapshots: [entry({ status: "zombie" as never })] });
  assert.throws(() => parseSnapshotRegistry(raw), /status/i);
});

test("loadSnapshotRegistry returns an empty registry when the file is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "snap-empty-"));
  assert.deepEqual(loadSnapshotRegistry(root), emptyRegistry());
});

test("writeSnapshotRegistry then loadSnapshotRegistry round-trips through disk", () => {
  const root = mkdtempSync(join(tmpdir(), "snap-io-"));
  const registry = { snapshots: [entry()] };
  writeSnapshotRegistry(root, registry);
  assert.deepEqual(loadSnapshotRegistry(root), registry);
  assert.match(readFileSync(join(root, "snapshots.json"), "utf8"), /v0\.18\.1-beta/);
});

test("supportedSnapshotIds lists develop first, then releases newest first", () => {
  const registry = {
    snapshots: [
      entry({ id: "v0.18.0-beta", d2eTag: "v0.18.0-beta" }),
      entry({ id: "develop", d2eTag: "develop", isDevelop: true }),
      entry({ id: "v0.18.1-beta", d2eTag: "v0.18.1-beta" }),
      entry({ id: "v0.17.1-beta", d2eTag: "v0.17.1-beta", status: "retired" }),
    ],
  };
  assert.deepEqual(supportedSnapshotIds(registry), ["develop", "v0.18.1-beta", "v0.18.0-beta"]);
});

test("registerSnapshot adds an entry without mutating the input registry", () => {
  const before = { snapshots: [entry({ id: "develop", d2eTag: "develop", isDevelop: true })] };
  const after = registerSnapshot(before, entry());
  assert.equal(before.snapshots.length, 1);
  assert.deepEqual(supportedSnapshotIds(after), ["develop", "v0.18.1-beta"]);
});

test("registerSnapshot replaces an entry with the same id", () => {
  const before = { snapshots: [entry({ pins: { atlas3: "old", trex: "old" } })] };
  const after = registerSnapshot(before, entry());
  assert.equal(after.snapshots.length, 1);
  assert.deepEqual(after.snapshots[0].pins, { atlas3: "9baa99a", trex: "dec4a95" });
});

test("registerSnapshot retires releases beyond the two most recent", () => {
  let registry = { snapshots: [entry({ id: "develop", d2eTag: "develop", isDevelop: true })] };
  for (const id of ["v0.17.1-beta", "v0.18.0-beta", "v0.18.1-beta"]) {
    registry = registerSnapshot(registry, entry({ id, d2eTag: id }));
  }
  assert.deepEqual(supportedSnapshotIds(registry), ["develop", "v0.18.1-beta", "v0.18.0-beta"]);
  const retired = registry.snapshots.filter((s) => s.status === "retired").map((s) => s.id);
  assert.deepEqual(retired, ["v0.17.1-beta"]);
  assert.equal(
    registry.snapshots.filter((s) => s.status === "active" && !s.isDevelop).length,
    MAX_ACTIVE_RELEASES,
  );
});

test("registerSnapshot never retires develop", () => {
  let registry = { snapshots: [entry({ id: "develop", d2eTag: "develop", isDevelop: true })] };
  for (const id of ["v0.18.0-beta", "v0.18.1-beta", "v0.19.0-beta"]) {
    registry = registerSnapshot(registry, entry({ id, d2eTag: id }));
  }
  assert.equal(registry.snapshots.find((s) => s.isDevelop)?.status, "active");
});
