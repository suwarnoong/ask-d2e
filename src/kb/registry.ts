import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./gitOps.js";

export interface PromptSpec {
  audience: string;
  exampleQuestions: string[];
  focusAreas: string[];
  scopeNotes: string;
}

export interface RegistryEntry {
  name: string;
  sourceRepo: string;
  promptSpec: PromptSpec;
  cadence: "daily" | "weekly";
  status: "active" | "pending-initial-build";
  createdBy: string;
  createdAt: string;
  lastRefreshedAt: string | null;
  lastAutoRefreshAt: string | null;
}

export function loadRegistry(kbRoot: string): RegistryEntry[] {
  return JSON.parse(readFileSync(join(kbRoot, "repos.json"), "utf8"));
}

/** The time to wait between two refreshes. It is also the default PR window. */
export function cadenceWindowMs(cadence: RegistryEntry["cadence"]): number {
  return cadence === "daily" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
}

export function isDue(entry: RegistryEntry, now: Date): boolean {
  if (!entry.lastRefreshedAt) return true;
  const elapsedMs = now.getTime() - new Date(entry.lastRefreshedAt).getTime();
  return elapsedMs >= cadenceWindowMs(entry.cadence);
}

export const AUTO_REFRESH_COOLDOWN_MS = 60 * 60 * 1000;

export function canAutoRefresh(entry: RegistryEntry, now: Date): boolean {
  if (!entry.lastAutoRefreshAt) return true;
  return now.getTime() - new Date(entry.lastAutoRefreshAt).getTime() >= AUTO_REFRESH_COOLDOWN_MS;
}

export async function withRegistryRetry(
  kbRoot: string,
  branch: string,
  mutate: (entries: RegistryEntry[]) => RegistryEntry[],
  commitMessage: string,
  maxAttempts = 5,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    git(kbRoot, ["fetch", "origin", branch]);
    git(kbRoot, ["reset", "--hard", `origin/${branch}`]);
    const current = loadRegistry(kbRoot);
    const next = mutate(current);
    writeFileSync(join(kbRoot, "repos.json"), JSON.stringify(next, null, 2) + "\n");
    git(kbRoot, ["add", "repos.json"]);
    if (git(kbRoot, ["status", "--porcelain", "repos.json"]).length === 0) return;
    git(kbRoot, [
      "-c", "user.name=ask-d2e",
      "-c", "user.email=actions@github.com",
      "commit", "-m", commitMessage,
    ]);
    try {
      git(kbRoot, ["push", "origin", `HEAD:${branch}`]);
      return;
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      // another writer landed first — loop: refetch, re-apply mutate against the new base, retry
    }
  }
}
