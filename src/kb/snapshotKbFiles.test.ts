import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  safeSnapshotGeneratedPath,
  applySnapshotKbChanges,
  safeSharedContractPath,
  applySharedContractChanges,
} from "./snapshotKbFiles.js";

const ROOT = "/tmp/kb-root";

test("safeSnapshotGeneratedPath accepts a path under the snapshot's generated repo dir", () => {
  assert.equal(
    safeSnapshotGeneratedPath(ROOT, "develop", "atlas3", "snapshots/develop/generated/atlas3/00-overview/intro.md"),
    join(ROOT, "snapshots", "develop", "generated", "atlas3", "00-overview", "intro.md"),
  );
});

test("safeSnapshotGeneratedPath refuses another snapshot, another repo and traversal", () => {
  assert.throws(() =>
    safeSnapshotGeneratedPath(ROOT, "develop", "atlas3", "snapshots/v0.18.1-beta/generated/atlas3/a.md"),
  );
  assert.throws(() => safeSnapshotGeneratedPath(ROOT, "develop", "atlas3", "snapshots/develop/generated/trex/a.md"));
  assert.throws(() => safeSnapshotGeneratedPath(ROOT, "develop", "atlas3", "snapshots/develop/generated/atlas3/../../x.md"));
});

test("safeSnapshotGeneratedPath refuses non-markdown", () => {
  assert.throws(
    () => safeSnapshotGeneratedPath(ROOT, "develop", "atlas3", "snapshots/develop/generated/atlas3/package.json"),
    /markdown/i,
  );
});

test("applySnapshotKbChanges writes under the generated dir and returns the paths", () => {
  const root = mkdtempSync(join(tmpdir(), "snap-kb-"));
  const paths = applySnapshotKbChanges(
    [
      {
        path: "snapshots/develop/generated/atlas3/00-overview/intro.md",
        action: "create",
        rationale: "r",
        source_prs: [],
        content: "# Atlas3\n\nIntro.",
      },
    ],
    root,
    "develop",
    "atlas3",
  );
  assert.deepEqual(paths, ["snapshots/develop/generated/atlas3/00-overview/intro.md"]);
  assert.match(
    readFileSync(join(root, "snapshots/develop/generated/atlas3/00-overview/intro.md"), "utf8"),
    /# Atlas3/,
  );
});

test("safeSharedContractPath only allows the shared contract dir", () => {
  assert.equal(
    safeSharedContractPath(ROOT, "repos/_shared/webapi-contract/00-overview/sources.md"),
    join(ROOT, "repos", "_shared", "webapi-contract", "00-overview", "sources.md"),
  );
  assert.throws(() => safeSharedContractPath(ROOT, "repos/_shared/other/x.md"));
  assert.throws(() => safeSharedContractPath(ROOT, "curated/faq/faq-01.md"));
});

test("applySharedContractChanges writes the contract tier", () => {
  const root = mkdtempSync(join(tmpdir(), "shared-kb-"));
  const paths = applySharedContractChanges(
    [
      {
        path: "repos/_shared/webapi-contract/00-overview/intro.md",
        action: "create",
        rationale: "r",
        source_prs: [],
        content: "# WebAPI contract\n\nSpecification, not a shipped component.",
      },
    ],
    root,
  );
  assert.deepEqual(paths, ["repos/_shared/webapi-contract/00-overview/intro.md"]);
});
