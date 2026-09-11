import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFaqFile, loadFaq, renderFaqForPrompt } from "./faq.js";

const VALID = [
  "---",
  "id: faq-03",
  "question: What level of technical support does Data4Life provide?",
  "tags: [support, sla]",
  "owner: project-manager",
  "lastReviewed: 2026-09-11",
  "verifiableClaims:",
  "  - claim: There is no 24/7 commercial SLA",
  "---",
  "",
  "Community support via Slack, GitHub and email.",
].join("\n");

test("parseFaqFile reads every field", () => {
  const entry = parseFaqFile("curated/faq/faq-03.md", VALID);
  assert.equal(entry.id, "faq-03");
  assert.equal(entry.path, "curated/faq/faq-03.md");
  assert.deepEqual(entry.tags, ["support", "sla"]);
  assert.deepEqual(entry.verifiableClaims, [{ claim: "There is no 24/7 commercial SLA" }]);
  assert.match(entry.body, /Community support/);
});

test("parseFaqFile throws, naming the file, when a required field is missing", () => {
  const raw = ["---", "id: faq-04", "---", "body"].join("\n");
  assert.throws(() => parseFaqFile("curated/faq/faq-04.md", raw), /faq-04\.md.*question/s);
});

test("parseFaqFile throws when the body is empty", () => {
  const raw = VALID.replace("Community support via Slack, GitHub and email.", "");
  assert.throws(() => parseFaqFile("curated/faq/faq-03.md", raw), /empty body/i);
});

test("parseFaqFile tolerates absent optional lists", () => {
  const raw = [
    "---",
    "id: faq-05",
    "question: Q?",
    "owner: project-manager",
    "lastReviewed: 2026-09-11",
    "---",
    "A.",
  ].join("\n");
  const entry = parseFaqFile("curated/faq/faq-05.md", raw);
  assert.deepEqual(entry.tags, []);
  assert.deepEqual(entry.verifiableClaims, []);
});

test("loadFaq reads every file, sorted by id", () => {
  const root = mkdtempSync(join(tmpdir(), "faq-"));
  const dir = join(root, "curated", "faq");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "faq-03.md"), VALID);
  writeFileSync(join(dir, "faq-01.md"), VALID.replace("faq-03", "faq-01"));

  const entries = loadFaq(root);
  assert.deepEqual(entries.map((e) => e.id), ["faq-01", "faq-03"]);
  assert.deepEqual(entries.map((e) => e.path), ["curated/faq/faq-01.md", "curated/faq/faq-03.md"]);
});

test("loadFaq returns an empty array when there is no curated FAQ yet", () => {
  const root = mkdtempSync(join(tmpdir(), "faq-empty-"));
  assert.deepEqual(loadFaq(root), []);
});

test("loadFaq ignores non-entry files such as README.md", () => {
  const root = mkdtempSync(join(tmpdir(), "faq-readme-"));
  const dir = join(root, "curated", "faq");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "faq-03.md"), VALID);
  writeFileSync(join(dir, "README.md"), "# Curated FAQ\n\nFrontmatter contract documentation.\n");

  const entries = loadFaq(root);
  assert.deepEqual(entries.map((e) => e.id), ["faq-03"]);
});

test("renderFaqForPrompt emits every entry with its question, path and body", () => {
  const entries = [parseFaqFile("curated/faq/faq-03.md", VALID)];
  const rendered = renderFaqForPrompt(entries);

  assert.match(rendered, /CURATED FAQ \(TIER 1/);
  assert.match(rendered, /Q: What level of technical support/);
  assert.match(rendered, /curated\/faq\/faq-03\.md/);
  assert.match(rendered, /Community support via Slack/);
});

test("renderFaqForPrompt says so when the FAQ is empty", () => {
  assert.match(renderFaqForPrompt([]), /no curated FAQ entries/i);
});
