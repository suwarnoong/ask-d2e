import { test } from "node:test";
import assert from "node:assert/strict";
import { routeInteraction } from "./slack-interactions.js";

test("thumbs up always routes to thanks", () => {
  assert.equal(routeInteraction("feedback_up", true), "thanks");
  assert.equal(routeInteraction("feedback_up", false), "thanks");
});

test("thumbs down from a non-admin routes to log-and-notify-admins", () => {
  assert.equal(routeInteraction("feedback_down", false), "log-and-notify-admins");
});

test("thumbs down from an admin routes to dispatch-fix", () => {
  assert.equal(routeInteraction("feedback_down", true), "dispatch-fix");
});
