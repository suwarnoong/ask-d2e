import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripMdx, rewriteRelativeLinks, docOutputPath, extractDoc, extractDocsTree } from "./docsExtract.js";

test("stripMdx removes import lines", () => {
  const body = ["import Tabs from '@theme/Tabs';", "", "# Title", "", "Prose."].join("\n");
  const out = stripMdx(body);
  assert.doesNotMatch(out, /import Tabs/);
  assert.match(out, /# Title/);
  assert.match(out, /Prose\./);
});

test("stripMdx removes standalone JSX tags but keeps the prose inside", () => {
  const body = ["<Tabs>", "<TabItem value=\"mac\">", "", "Install with brew.", "", "</TabItem>", "</Tabs>"].join("\n");
  const out = stripMdx(body);
  assert.doesNotMatch(out, /<Tabs>|<TabItem|<\/TabItem>|<\/Tabs>/);
  assert.match(out, /Install with brew\./);
});

test("stripMdx leaves inline HTML in prose alone", () => {
  assert.match(stripMdx("Use the <code>d2e</code> binary."), /<code>d2e<\/code>/);
});

test("stripMdx collapses runs of blank lines left behind", () => {
  const out = stripMdx(["# T", "", "", "", "Prose."].join("\n"));
  assert.doesNotMatch(out, /\n{3,}/);
});

test("rewriteRelativeLinks resolves a sibling link against the output tree", () => {
  const body = "See [the CLI guide](./cli.md).";
  const out = rewriteRelativeLinks(body, "2-admin_guide/5-setup/0-system-setup/env-vars.md");
  assert.match(out, /\(2-admin_guide\/5-setup\/0-system-setup\/cli\.md\)/);
});

test("rewriteRelativeLinks resolves a parent link", () => {
  const body = "See [setup](../README.md).";
  const out = rewriteRelativeLinks(body, "2-admin_guide/5-setup/0-system-setup/env-vars.md");
  assert.match(out, /\(2-admin_guide\/5-setup\/index\.md\)/);
});

test("rewriteRelativeLinks leaves absolute and external links alone", () => {
  const body = "[site](https://data2evidence.org) and [root](/docs/intro)";
  const out = rewriteRelativeLinks(body, "a/b.md");
  assert.match(out, /https:\/\/data2evidence\.org/);
  assert.match(out, /\(\/docs\/intro\)/);
});

test("docOutputPath renames README.md to index.md", () => {
  assert.equal(docOutputPath("1-user_guide/README.md"), "1-user_guide/index.md");
  assert.equal(docOutputPath("1-user_guide/4-Cohorts/README.md"), "1-user_guide/4-Cohorts/index.md");
  assert.equal(docOutputPath("2-admin_guide/5-setup/0-system-setup/cli.md"), "2-admin_guide/5-setup/0-system-setup/cli.md");
});

test("docOutputPath rewrites .mdx to .md", () => {
  assert.equal(docOutputPath("a/b.mdx"), "a/b.md");
});

test("extractDoc prefers the frontmatter title", () => {
  const raw = ["---", "sidebar_position: 3", "title: The CLI", "---", "", "# cli", "", "Prose."].join("\n");
  const doc = extractDoc("2-admin_guide/cli.md", raw);
  assert.equal(doc.title, "The CLI");
  assert.equal(doc.outPath, "2-admin_guide/cli.md");
  assert.equal(doc.sourcePath, "2-admin_guide/cli.md");
  assert.doesNotMatch(doc.content, /sidebar_position/);
});

test("extractDoc falls back to the first heading when frontmatter has no title", () => {
  const raw = ["---", "sidebar_position: 3", "---", "", "# The CLI", "", "Prose."].join("\n");
  assert.equal(extractDoc("a/cli.md", raw).title, "The CLI");
});

test("extractDoc prepends a provenance line naming the source", () => {
  const doc = extractDoc("a/cli.md", "# CLI\n\nProse.");
  assert.match(doc.content, /^<!-- source: docs\/website\/docs\/a\/cli\.md -->/);
});

test("extractDocsTree walks nested directories and skips non-markdown", () => {
  const root = mkdtempSync(join(tmpdir(), "docs-"));
  mkdirSync(join(root, "2-admin_guide", "5-setup"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Index\n\nTop.");
  writeFileSync(join(root, "2-admin_guide", "5-setup", "cli.md"), "# CLI\n\nProse.");
  writeFileSync(join(root, "2-admin_guide", "5-setup", "diagram.png"), "not markdown");

  const docs = extractDocsTree(root);

  assert.deepEqual(docs.map((d) => d.outPath), ["2-admin_guide/5-setup/cli.md", "index.md"]);
});

test("extractDocsTree returns an empty array when the docs root is absent", () => {
  assert.deepEqual(extractDocsTree(join(tmpdir(), "definitely-not-here-12345")), []);
});
