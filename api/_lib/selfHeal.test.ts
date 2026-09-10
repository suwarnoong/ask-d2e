import { test } from "node:test";
import assert from "node:assert/strict";
import { decideSelfHealAction, buildCorrectDispatchPayload } from "./selfHeal.js";
import type { RegistryEntry } from "../../src/kb/registry.js";

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    name: "widgets",
    sourceRepo: "acme/widgets",
    promptSpec: { audience: "eng", exampleQuestions: [], focusAreas: [], scopeNotes: "" },
    cadence: "weekly",
    status: "active",
    createdBy: "U1",
    createdAt: "2026-01-01T00:00:00Z",
    lastRefreshedAt: null,
    lastAutoRefreshAt: null,
    ...overrides,
  };
}

test("no plausible repo -> admin-fallback", async () => {
  const classify = async () => null;
  const result = await decideSelfHealAction("q", [entry()], new Date(), classify);
  assert.deepEqual(result, { action: "admin-fallback" });
});

test("plausible repo not in cooldown -> dispatch", async () => {
  const classify = async () => "widgets";
  const now = new Date("2026-09-10T00:00:00Z");
  const result = await decideSelfHealAction("q", [entry({ lastAutoRefreshAt: null })], now, classify);
  assert.deepEqual(result, { action: "dispatch", repoName: "widgets" });
});

test("plausible repo in cooldown -> admin-fallback", async () => {
  const classify = async () => "widgets";
  const now = new Date("2026-09-10T00:00:00Z");
  const cooling = entry({ lastAutoRefreshAt: new Date(now.getTime() - 10 * 60_000).toISOString() });
  const result = await decideSelfHealAction("q", [cooling], now, classify);
  assert.deepEqual(result, { action: "admin-fallback" });
});

test("buildCorrectDispatchPayload shapes the gap-fill dispatch", () => {
  const payload = buildCorrectDispatchPayload("gap-fill", "widgets", "q", "interim answer", "U1", "C1", "T1");
  assert.equal(payload.ref, "main");
  assert.equal(payload.inputs.mode, "gap-fill");
  assert.equal(payload.inputs.repo_name, "widgets");
  assert.equal(payload.inputs.slack_channel, "C1");
  assert.equal(payload.inputs.slack_thread_ts, "T1");
});
