import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { scopeForSnapshot, isWithinScope, resolveScopedPath } from "./kbScope.js";

const ROOT = "/tmp/kb-root";

test("scopeForSnapshot allows the snapshot, the shared contract and the curated FAQ", () => {
  const scope = scopeForSnapshot(ROOT, "v0.18.1-beta");
  assert.equal(scope.kbRoot, ROOT);
  assert.deepEqual(scope.allowedPrefixes, [
    "snapshots/v0.18.1-beta",
    "repos/_shared",
    "curated",
  ]);
});

test("isWithinScope accepts paths under an allowed prefix", () => {
  const scope = scopeForSnapshot(ROOT, "develop");
  assert.equal(isWithinScope(scope, "snapshots/develop/docs/setup/cli.md"), true);
  assert.equal(isWithinScope(scope, "repos/_shared/webapi-contract/sources.md"), true);
  assert.equal(isWithinScope(scope, "curated/faq/faq-01.md"), true);
});

test("isWithinScope rejects another snapshot", () => {
  const scope = scopeForSnapshot(ROOT, "develop");
  assert.equal(isWithinScope(scope, "snapshots/v0.17.1-beta/docs/setup/cli.md"), false);
});

test("isWithinScope rejects a prefix that only shares a string prefix", () => {
  const scope = scopeForSnapshot(ROOT, "develop");
  assert.equal(isWithinScope(scope, "snapshots/develop-evil/docs/x.md"), false);
});

test("isWithinScope rejects traversal out of the root", () => {
  const scope = scopeForSnapshot(ROOT, "develop");
  assert.equal(isWithinScope(scope, "snapshots/develop/../../../etc/passwd"), false);
  assert.equal(isWithinScope(scope, "../secrets.md"), false);
});

test("isWithinScope rejects absolute paths", () => {
  const scope = scopeForSnapshot(ROOT, "develop");
  assert.equal(isWithinScope(scope, "/etc/passwd"), false);
});

test("resolveScopedPath returns an absolute path for an allowed relative path", () => {
  const scope = scopeForSnapshot(ROOT, "develop");
  assert.equal(
    resolveScopedPath(scope, "snapshots/develop/docs/setup/cli.md"),
    resolve(ROOT, "snapshots/develop/docs/setup/cli.md"),
  );
});

test("resolveScopedPath throws on an out-of-scope path, naming the path", () => {
  const scope = scopeForSnapshot(ROOT, "develop");
  assert.throws(
    () => resolveScopedPath(scope, "snapshots/v0.17.1-beta/docs/x.md"),
    /outside the allowed scope.*v0\.17\.1-beta/s,
  );
});

test("resolveScopedPath allows a directory, not only markdown", () => {
  const scope = scopeForSnapshot(ROOT, "develop");
  assert.equal(
    resolveScopedPath(scope, "snapshots/develop/docs"),
    resolve(ROOT, "snapshots/develop/docs"),
  );
});
