import { join } from "node:path";
import { generateRepoKb, type ClaudeCaller } from "./generateRepoKb.js";
import { cloneAtRef, type Cloner } from "./snapshotSources.js";
import { applySharedContractChanges } from "./snapshotKbFiles.js";
import { WEBAPI_CONTRACT } from "./repoPromptSpecs.js";
import type { ClaudeAuth } from "../shared/config.js";

export interface BuildSharedContractInput {
  kbRoot: string;
  workRoot: string;
  auth: ClaudeAuth;
  deps?: { clone?: Cloner; callClaude?: ClaudeCaller };
}

export interface BuildSharedContractResult {
  files: number;
  paths: string[];
}

/**
 * Builds the version-independent WebAPI contract tier. It lives outside snapshots because the
 * contract does not vary by D2E release — and because it is not shipped in a D2E install, which
 * the prompt states explicitly.
 */
export async function buildSharedContract(
  input: BuildSharedContractInput,
): Promise<BuildSharedContractResult> {
  const clone =
    input.deps?.clone ?? ((request) => cloneAtRef(request, process.env.SOURCE_REPOS_TOKEN ?? ""));
  const dir = join(input.workRoot, "webapi-contract");
  await clone({ repo: WEBAPI_CONTRACT.sourceRepo, ref: WEBAPI_CONTRACT.ref, dir });

  const plan = await generateRepoKb({
    sourceDir: dir,
    repoName: WEBAPI_CONTRACT.repoName,
    sourceRepo: WEBAPI_CONTRACT.sourceRepo,
    promptSpec: WEBAPI_CONTRACT.promptSpec,
    target: {
      pathPrefix: WEBAPI_CONTRACT.pathPrefix,
      contractNote:
        "This repository is the upstream contract specification that Data2Evidence reimplements. " +
        "Describe it as a contract, never as the behaviour of a running Data2Evidence install.",
    },
    auth: input.auth,
    fileCap: 350,
    callClaude: input.deps?.callClaude,
  });

  const paths = applySharedContractChanges(plan.changes, input.kbRoot);
  return { files: paths.length, paths };
}
