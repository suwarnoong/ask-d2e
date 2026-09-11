import {
  buildInitialBuildPrompt,
  listSourceFiles,
  readReadmes,
  type PromptTarget,
} from "./initialBuildPrompt.js";
import { parseKbResponse, type KbPlan } from "./responseParsing.js";
import { callClaude as realCallClaude, type CallClaudeOptions } from "../shared/claude.js";
import type { ClaudeAuth } from "../shared/config.js";
import type { PromptSpec } from "./registry.js";

export type { PromptTarget };

export type ClaudeCaller = (
  prompt: string,
  auth: ClaudeAuth,
  opts?: CallClaudeOptions,
) => Promise<string>;

export interface GenerateRepoKbOptions {
  sourceDir: string;
  repoName: string;
  sourceRepo: string;
  promptSpec: PromptSpec;
  target: PromptTarget;
  auth: ClaudeAuth;
  callClaude?: ClaudeCaller;
}

export function buildRepoPrompt(options: GenerateRepoKbOptions): string {
  const allFiles = listSourceFiles(options.sourceDir);
  return buildInitialBuildPrompt(
    options.sourceRepo,
    options.repoName,
    options.promptSpec,
    allFiles,
    readReadmes(options.sourceDir),
    allFiles.length,
    options.target,
  );
}

/** Generates a repo's knowledge base plan. Writes nothing — the orchestrator owns I/O. */
export async function generateRepoKb(options: GenerateRepoKbOptions): Promise<KbPlan> {
  const callClaude = options.callClaude ?? realCallClaude;
  const raw = await callClaude(buildRepoPrompt(options), options.auth, {
    cwd: options.sourceDir,
    allowedTools: ["Read", "Grep", "Glob"],
  });
  return parseKbResponse(raw);
}
