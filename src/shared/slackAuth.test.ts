import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifySlackSignature, adminIds, isAdmin, friendlyError } from "./slackAuth.js";

function sign(secret: string, timestamp: string, body: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(`v0:${timestamp}:${body}`);
  return `v0=${hmac.digest("hex")}`;
}

test("verifySlackSignature accepts a valid signature", () => {
  const secret = "shh";
  const body = '{"a":1}';
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign(secret, ts, body);
  assert.equal(verifySlackSignature(body, sig, ts, secret), true);
});

test("verifySlackSignature rejects a wrong secret", () => {
  const body = '{"a":1}';
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign("shh", ts, body);
  assert.equal(verifySlackSignature(body, sig, ts, "different"), false);
});

test("verifySlackSignature rejects missing signature or timestamp", () => {
  assert.equal(verifySlackSignature("body", null, "123", "secret"), false);
  assert.equal(verifySlackSignature("body", "v0=abc", null, "secret"), false);
});

test("verifySlackSignature rejects a stale timestamp (replay protection)", () => {
  const secret = "shh";
  const body = "body";
  const staleTs = String(Math.floor(Date.now() / 1000) - 400);
  const sig = sign(secret, staleTs, body);
  assert.equal(verifySlackSignature(body, sig, staleTs, secret), false);
});

test("adminIds parses a comma-separated env var, trims, filters empty", () => {
  process.env.KB_FEEDBACK_ADMIN_IDS = " U1 , U2,, U3 ";
  assert.deepEqual([...adminIds()].sort(), ["U1", "U2", "U3"]);
  delete process.env.KB_FEEDBACK_ADMIN_IDS;
});

test("isAdmin checks membership, false for unset user", () => {
  process.env.KB_FEEDBACK_ADMIN_IDS = "U1,U2";
  assert.equal(isAdmin("U1"), true);
  assert.equal(isAdmin("U9"), false);
  assert.equal(isAdmin(undefined), false);
  delete process.env.KB_FEEDBACK_ADMIN_IDS;
});

test("friendlyError masks 429/529/5xx-shaped errors", () => {
  assert.equal(friendlyError(new Error("429 rate limited")), "The AI service is busy right now — please try again in a moment");
  assert.equal(friendlyError(new Error("upstream 529 overloaded")), "The AI service is busy right now — please try again in a moment");
  assert.equal(friendlyError(new Error("500 internal server error")), "The AI service is busy right now — please try again in a moment");
});

test("friendlyError passes through other errors' messages", () => {
  assert.equal(friendlyError(new Error("repo not found in registry")), "repo not found in registry");
});

test("friendlyError has a generic fallback for non-Error throwables", () => {
  assert.equal(friendlyError("a string throw"), "Something went wrong — please try again.");
});
