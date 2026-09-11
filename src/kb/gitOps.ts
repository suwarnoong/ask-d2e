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

export interface RepoPlan {
  repoName: string;
  plan: KbPlan;
}

/**
 * Make one commit for the KB folders of many repos. A refresh run can change more than one
 * repo. One commit for each repo would cause one push for each repo, and the pushes would
 * compete with each other.
 */
export function commitAndPushMany(
  kbRoot: string,
  repoPlans: RepoPlan[],
  branch: string,
  subject: string,
): boolean {
  const pathspecs: string[] = [];
  for (const { repoName } of repoPlans) {
    const pathspec = `repos/${repoName}/knowledge-base`;
    if (!existsSync(join(kbRoot, pathspec))) continue;
    git(kbRoot, ["add", pathspec]);
    pathspecs.push(pathspec);
  }
  if (pathspecs.length === 0) return false;
  if (git(kbRoot, ["status", "--porcelain", ...pathspecs]).length === 0) return false;

  const body = repoPlans
    .flatMap(({ repoName, plan }) => [
      `${repoName}: ${plan.summary}`,
      ...plan.changes.map((c) => `  - ${c.action} ${c.path}: ${c.rationale}`),
      "",
    ])
    .join("\n")
    .trimEnd();
  git(kbRoot, [
    "-c", "user.name=ask-d2e",
    "-c", "user.email=actions@github.com",
    "commit", "-m", `${subject}\n\n${body}`,
  ]);
  pushWithRebase(kbRoot, branch);
  return true;
}

/**
 * Clone a source repo with a depth of 1 while the job runs. The refresh job cannot use a fixed
 * `actions/checkout` step. It knows which repos to clone only after it reads `repos.json` and
 * calls `isDue()`.
 */
export function cloneSourceRepo(sourceRepo: string, token: string, destDir: string): void {
  const url = `https://x-access-token:${token}@github.com/${sourceRepo}.git`;
  const result = spawnSync("git", ["clone", "--depth", "1", url, destDir], { encoding: "utf8" });
  if (result.status !== 0) {
    // Git writes the remote URL when it fails. Do not let the token go to the log.
    const stderr = (result.stderr ?? "").split(token).join("***");
    throw new Error(`git clone of ${sourceRepo} failed: ${stderr}`);
  }
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
