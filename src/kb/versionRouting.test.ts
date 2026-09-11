import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSnapshotOverride, resolveSnapshot } from "./versionRouting.js";
import type { SnapshotEntry, SnapshotRegistry } from "./snapshots.js";

function entry(id: string, isDevelop = false): SnapshotEntry {
  return {
    id,
    d2eTag: id,
    pins: { atlas3: "9baa99a", trex: "dec4a95" },
    status: "active",
    builtAt: "2026-09-11T00:00:00.000Z",
    isDevelop,
  };
}

const REGISTRY: SnapshotRegistry = {
  snapshots: [entry("develop", true), entry("v0.18.1-beta"), entry("v0.18.0-beta")],
};

test("parseSnapshotOverride strips a leading version token", () => {
  assert.deepEqual(parseSnapshotOverride("v0.18.1 why does the stack fail?"), {
    requested: "v0.18.1",
    question: "why does the stack fail?",
  });
});

test("parseSnapshotOverride strips a leading develop token", () => {
  assert.deepEqual(parseSnapshotOverride("develop how do I start?"), {
    requested: "develop",
    question: "how do I start?",
  });
});

test("parseSnapshotOverride leaves an ordinary question alone", () => {
  const q = "why does v0.18.1 fail to start?";
  assert.deepEqual(parseSnapshotOverride(q), { requested: null, question: q });
});

test("resolveSnapshot defaults to develop with no request", () => {
  const resolution = resolveSnapshot({ requested: null, registry: REGISTRY });
  assert.equal(resolution.snapshotId, "develop");
  assert.equal(resolution.unsupported, false);
  assert.equal(resolution.caveat, null);
});

test("resolveSnapshot honours an exact request", () => {
  const resolution = resolveSnapshot({ requested: "v0.18.1-beta", registry: REGISTRY });
  assert.equal(resolution.snapshotId, "v0.18.1-beta");
  assert.equal(resolution.unsupported, false);
});

test("resolveSnapshot matches a partial version to the newest snapshot that fits", () => {
  assert.equal(resolveSnapshot({ requested: "v0.18.1", registry: REGISTRY }).snapshotId, "v0.18.1-beta");
  assert.equal(resolveSnapshot({ requested: "v0.18.0", registry: REGISTRY }).snapshotId, "v0.18.0-beta");
});

test("resolveSnapshot prefers the supplied default over develop", () => {
  const resolution = resolveSnapshot({ requested: null, defaultId: "v0.18.1-beta", registry: REGISTRY });
  assert.equal(resolution.snapshotId, "v0.18.1-beta");
});

test("resolveSnapshot ignores a default that is not supported", () => {
  const resolution = resolveSnapshot({ requested: null, defaultId: "v0.17.1-beta", registry: REGISTRY });
  assert.equal(resolution.snapshotId, "develop");
});

test("an unsupported request resolves to the oldest supported release with a caveat", () => {
  const resolution = resolveSnapshot({ requested: "v0.17", registry: REGISTRY });
  assert.equal(resolution.unsupported, true);
  assert.equal(resolution.snapshotId, "v0.18.0-beta");
  assert.match(resolution.caveat ?? "", /outside the supported range/);
  assert.match(resolution.caveat ?? "", /develop, v0\.18\.1-beta, v0\.18\.0-beta/);
  assert.match(resolution.caveat ?? "", /v0\.17/);
});

test("an empty registry still resolves to develop rather than failing", () => {
  const resolution = resolveSnapshot({ requested: "v0.18.1", registry: { snapshots: [] } });
  assert.equal(resolution.snapshotId, "develop");
  assert.equal(resolution.unsupported, true);
  assert.match(resolution.caveat ?? "", /develop/);
});
