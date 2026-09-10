import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRepoKbPath, readRepoKb, renderKb, applyKbChanges } from "./kbFiles.js";

function makeKbRoot(): string {
  return mkdtempSync(join(tmpdir(), "kbfiles-"));
}

test("safeRepoKbPath accepts a valid path inside the repo's kb folder", () => {
  const kbRoot = makeKbRoot();
  const result = safeRepoKbPath(kbRoot, "acme", "repos/acme/knowledge-base/00-overview/intro.md");
  assert.ok(result.endsWith(join("repos", "acme", "knowledge-base", "00-overview", "intro.md")));
});

test("safeRepoKbPath rejects path traversal", () => {
  const kbRoot = makeKbRoot();
  assert.throws(() => safeRepoKbPath(kbRoot, "acme", "repos/acme/knowledge-base/../../../etc/passwd"));
});

test("safeRepoKbPath rejects a non-markdown target", () => {
  const kbRoot = makeKbRoot();
  assert.throws(() => safeRepoKbPath(kbRoot, "acme", "repos/acme/knowledge-base/notes.txt"));
});

test("safeRepoKbPath rejects a path naming a different repo", () => {
  const kbRoot = makeKbRoot();
  assert.throws(() => safeRepoKbPath(kbRoot, "acme", "repos/other-repo/knowledge-base/x.md"));
});

test("readRepoKb and renderKb round-trip a small fixture tree", () => {
  const kbRoot = makeKbRoot();
  const dir = join(kbRoot, "repos", "acme", "knowledge-base", "00-overview");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "intro.md"), "# Intro\ncontent");

  const files = readRepoKb(kbRoot, "acme");
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "repos/acme/knowledge-base/00-overview/intro.md");

  const rendered = renderKb(files);
  assert.ok(rendered.includes("===== FILE: repos/acme/knowledge-base/00-overview/intro.md ====="));
  assert.ok(rendered.includes("content"));
});

test("renderKb falls back to a path+heading index when over budget", () => {
  const files = [
    { path: "repos/acme/knowledge-base/a.md", content: "# Heading A\n" + "x".repeat(1000) },
    { path: "repos/acme/knowledge-base/b.md", content: "# Heading B\n" + "y".repeat(1000) },
  ];
  const rendered = renderKb(files, 500);
  assert.ok(rendered.includes("repos/acme/knowledge-base/a.md"));
  assert.ok(rendered.includes("Heading A"));
  assert.ok(!rendered.includes("x".repeat(1000)));
});

test("applyKbChanges writes valid changes and creates parent dirs", () => {
  const kbRoot = makeKbRoot();
  const written = applyKbChanges(
    [{ path: "repos/acme/knowledge-base/01-new/page.md", action: "create", rationale: "r", source_prs: [], content: "hello" }],
    kbRoot,
    "acme",
  );
  assert.deepEqual(written, ["repos/acme/knowledge-base/01-new/page.md"]);
  const content = readFileSync(join(kbRoot, "repos", "acme", "knowledge-base", "01-new", "page.md"), "utf8");
  assert.equal(content, "hello\n");
});

test("applyKbChanges aborts the whole batch when one entry is invalid — no partial writes", () => {
  const kbRoot = makeKbRoot();
  assert.throws(() =>
    applyKbChanges(
      [
        { path: "repos/acme/knowledge-base/ok.md", action: "create", rationale: "r", source_prs: [], content: "good" },
        { path: "repos/other/knowledge-base/bad.md", action: "create", rationale: "r", source_prs: [], content: "bad" },
      ],
      kbRoot,
      "acme",
    ),
  );
  assert.equal(existsSync(join(kbRoot, "repos", "acme", "knowledge-base", "ok.md")), false);
});
