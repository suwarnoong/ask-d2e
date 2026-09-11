import { join } from "node:path";
import { generateRepoKb, type ClaudeCaller } from "./generateRepoKb.js";
import { cloneAtRef, type Cloner } from "./snapshotSources.js";
import { applySnapshotKbChanges } from "./snapshotKbFiles.js";
import { rebuildSnapshotManifest } from "./snapshotManifest.js";
import { REPO_PROMPT_SPECS, GENERATED_REPOS } from "./repoPromptSpecs.js";
import type { GeneratedRepo } from "./repoPromptSpecs.js";
import type { ClaudeAuth } from "../shared/config.js";

export interface BuildSnapshotKbInput {
  kbRoot: string;
  snapshotId: string;
  refs: { d2e: string; atlas3: string; trex: string };
  auth: ClaudeAuth;
  /** Parent directory for the per-repo checkouts. */
  workRoot: string;
  /** Limit the run to some repos (a full run generates all three). */
  repos?: GeneratedRepo["name"][];
  deps?: { clone?: Cloner; callClaude?: ClaudeCaller };
}

export interface BuildSnapshotKbResult {
  repos: { repoName: string; files: number }[];
  manifestEntries: number;
}

/**
 * Generate the tier-3 KB for every repo of one snapshot. Collect first — all clones and all model
 * calls — and only then write, so a failure cannot leave a half-built snapshot behind.
 */
export async function buildSnapshotKb(input: BuildSnapshotKbInput): Promise<BuildSnapshotKbResult> {
  const clone =
    input.deps?.clone ?? ((request) => cloneAtRef(request, process.env.SOURCE_REPOS_TOKEN ?? ""));

  const wanted = input.repos ? GENERATED_REPOS.filter((r) => input.repos?.includes(r.name)) : GENERATED_REPOS;
  if (wanted.length === 0) throw new Error(`No known repos in KB_REPOS: ${input.repos?.join(", ")}`);

  const collected = [];
  for (const repo of wanted) {
    console.log(`Generating ${repo.name} from ${repo.sourceRepo}@${input.refs[repo.name]}...`);
    const dir = join(input.workRoot, `${input.snapshotId}-${repo.name}`);
    clone({ repo: repo.sourceRepo, ref: input.refs[repo.name], dir });
    const plan = await generateRepoKb({
      sourceDir: dir,
      repoName: repo.name,
      sourceRepo: repo.sourceRepo,
      promptSpec: REPO_PROMPT_SPECS[repo.name],
      target: { pathPrefix: `snapshots/${input.snapshotId}/generated/${repo.name}/` },
      auth: input.auth,
      fileCap: repo.fileCap,
      callClaude: input.deps?.callClaude,
    });
    console.log(`  ${repo.name}: ${plan.changes.length} page(s) planned`);
    collected.push({ repo, plan });
  }

  const repos = collected.map(({ repo, plan }) => ({
    repoName: repo.name,
    files: applySnapshotKbChanges(plan.changes, input.kbRoot, input.snapshotId, repo.name).length,
  }));
  const manifest = rebuildSnapshotManifest(input.kbRoot, input.snapshotId);

  return { repos, manifestEntries: manifest.entries.length };
}
