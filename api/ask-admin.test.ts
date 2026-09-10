import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAdminCommand } from "./ask-admin.js";

test("parses add-repo", () => {
  assert.deepEqual(parseAdminCommand("add-repo acme/widgets"), { kind: "add-repo", sourceRepo: "acme/widgets" });
});

test("parses set-cadence", () => {
  assert.deepEqual(parseAdminCommand("set-cadence acme daily"), { kind: "set-cadence", name: "acme", cadence: "daily" });
});

test("parses edit-repo", () => {
  assert.deepEqual(parseAdminCommand("edit-repo acme"), { kind: "edit-repo", name: "acme" });
});

test("no args is unrecognized", () => {
  assert.equal(parseAdminCommand("").kind, "unrecognized");
});

test("a typo is unrecognized", () => {
  assert.equal(parseAdminCommand("addrepo acme/widgets").kind, "unrecognized");
});

test("remove-repo falls through to unrecognized (Phase 5, out of scope)", () => {
  assert.equal(parseAdminCommand("remove-repo acme").kind, "unrecognized");
});

test("set-cadence with an invalid value is unrecognized", () => {
  assert.equal(parseAdminCommand("set-cadence acme hourly").kind, "unrecognized");
});

test("tolerates extra whitespace", () => {
  assert.deepEqual(parseAdminCommand("  add-repo   acme/widgets  "), { kind: "add-repo", sourceRepo: "acme/widgets" });
});
