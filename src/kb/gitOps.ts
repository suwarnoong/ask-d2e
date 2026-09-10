import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { KbPlan } from "./responseParsing.js";

export function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function hasChanges(kbRoot: string, pathspec: string): boolean {
  return git(kbRoot, ["status", "--porcelain", pathspec]).length > 0;
}

export function commitAndPush(
  kbRoot: string,
  plan: KbPlan,
  repoName: string,
  branch: string,
  subjectOverride?: string,
): boolean {
  const pathspec = `repos/${repoName}/knowledge-base`;
  // `git add` errors outright on a pathspec that doesn't exist on disk at all (distinct from
  // "exists but unchanged") — that happens when no KB content has ever been written for this repo.
  if (!existsSync(join(kbRoot, pathspec))) return false;
  git(kbRoot, ["add", pathspec]);
  if (!hasChanges(kbRoot, pathspec)) return false;

  const subject = subjectOverride ?? `docs(kb): update ${repoName}`;
  const body = [plan.summary, "", ...plan.changes.map((c) => `- ${c.action} ${c.path}: ${c.rationale}`)].join("\n");
  git(kbRoot, [
    "-c", "user.name=ask-d2e",
    "-c", "user.email=actions@github.com",
    "commit", "-m", `${subject}\n\n${body}`,
  ]);
  pushWithRebase(kbRoot, branch);
  return true;
}

export function pushWithRebase(kbRoot: string, branch: string, attempts = 3): void {
  for (let attempt = 1; ; attempt++) {
    try {
      git(kbRoot, ["push", "origin", `HEAD:${branch}`]);
      return;
    } catch (err) {
      if (attempt >= attempts) throw err;
      git(kbRoot, ["fetch", "origin", branch]);
      try {
        git(kbRoot, ["rebase", "FETCH_HEAD"]);
      } catch (rebaseErr) {
        git(kbRoot, ["rebase", "--abort"]);
        throw rebaseErr;
      }
    }
  }
}
