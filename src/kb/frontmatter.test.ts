import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter } from "./frontmatter.js";

test("parses scalars, inline lists and claim blocks", () => {
  const raw = [
    "---",
    "id: faq-09",
    "question: How does D2E manage access: really?",
    "tags: [access-control, rbac]",
    "owner: project-manager",
    "lastReviewed: 2026-09-11",
    "verifiableClaims:",
    "  - claim: SSO is supported via Microsoft Entra",
    "  - claim: RBAC is fine-grained",
    "---",
    "",
    "Body text here.",
  ].join("\n");

  const { data, body } = parseFrontmatter(raw);

  assert.equal(data.id, "faq-09");
  assert.equal(data.question, "How does D2E manage access: really?");
  assert.deepEqual(data.tags, ["access-control", "rbac"]);
  assert.deepEqual(data.verifiableClaims, [
    { claim: "SSO is supported via Microsoft Entra" },
    { claim: "RBAC is fine-grained" },
  ]);
  assert.equal(body, "Body text here.");
});

test("strips balanced quotes from scalars", () => {
  const raw = ['---', 'id: "faq-01"', "owner: 'pm'", "---", "b"].join("\n");
  const { data } = parseFrontmatter(raw);
  assert.equal(data.id, "faq-01");
  assert.equal(data.owner, "pm");
});

test("an empty inline list yields an empty array", () => {
  const { data } = parseFrontmatter(["---", "tags: []", "---", "b"].join("\n"));
  assert.deepEqual(data.tags, []);
});

test("a block list with no items yields an empty array", () => {
  const { data } = parseFrontmatter(["---", "verifiableClaims:", "---", "b"].join("\n"));
  assert.deepEqual(data.verifiableClaims, []);
});

test("a document with no frontmatter returns empty data and the whole body", () => {
  const { data, body } = parseFrontmatter("# Just a doc\n\nprose");
  assert.deepEqual(data, {});
  assert.equal(body, "# Just a doc\n\nprose");
});

test("blank lines and comments inside frontmatter are ignored", () => {
  const raw = ["---", "# a comment", "", "id: faq-02", "---", "b"].join("\n");
  assert.equal(parseFrontmatter(raw).data.id, "faq-02");
});

test("an unterminated frontmatter block throws", () => {
  assert.throws(() => parseFrontmatter("---\nid: faq-01\nno terminator"), /unterminated/i);
});

test("an unsupported block-list item shape throws rather than silently dropping", () => {
  const raw = ["---", "verifiableClaims:", "  - just a bare string", "---", "b"].join("\n");
  assert.throws(() => parseFrontmatter(raw), /unsupported/i);
});

test("a line that is neither a key nor a list item throws", () => {
  assert.throws(() => parseFrontmatter(["---", "garbage line", "---", "b"].join("\n")), /unsupported/i);
});
