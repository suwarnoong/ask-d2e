import Anthropic from "@anthropic-ai/sdk";
import type { RegistryEntry } from "./registry.js";
import type { AnthropicLikeClient } from "../shared/anthropicLike.js";
import { taskModel } from "../shared/config.js";

/**
 * Every citation shape the answer engine can emit. Exported so the round-trip
 * test asserts against one source of truth rather than a copy.
 *
 *   snapshots/<id>/generated/<repo>/...  -> <repo>
 *   snapshots/<id>/docs/...              -> data2evidence (the docs site is in that repo)
 *   repos/_shared/...                    -> not correctable
 *   curated/...                          -> never correctable; human-authored
 *   repos/<name>/...                     -> <name> (legacy)
 */
export const CITATION_RE =
  /(?:snapshots\/[^/\s]+\/(?:generated\/(?<snapRepo>[^/\s]+)|(?<docs>docs))|curated\/(?<curated>[^/\s]+)|repos\/(?<repo>[^/\s]+))\//g;

/** The repo whose docs site is vendored at snapshots/<id>/docs. */
export const DOCS_SOURCE_REPO = "data2evidence";

function citedRepos(answerText: string): Set<string> {
  const names = new Set<string>();
  for (const match of answerText.matchAll(CITATION_RE)) {
    const groups = match.groups ?? {};
    if (groups.snapRepo) names.add(groups.snapRepo);
    else if (groups.docs) names.add(DOCS_SOURCE_REPO);
    else if (groups.repo && groups.repo !== "_shared") names.add(groups.repo);
    // curated/... and repos/_shared/... are deliberately not correctable.
  }
  return names;
}

export function resolveRepoFromCitation(answerText: string): string | null {
  const names = [...citedRepos(answerText)];
  return names.length === 1 ? names[0] : null;
}

// True when the answer cites at least one KB source path — i.e. it was grounded in real
// KB content, not a "we don't have that" miss. Used to gate self-heal: an answer that cited
// the KB shouldn't trigger a "doesn't cover that yet" follow-up even if it flagged NO_KB_MATCH.
// Unlike resolveRepoFromCitation, this counts curated and shared citations as grounding:
// they are real sources, just not correctable ones.
export function hasKbCitation(answerText: string): boolean {
  CITATION_RE.lastIndex = 0;
  return CITATION_RE.test(answerText);
}

export function buildClassificationPrompt(question: string, registry: RegistryEntry[]): string {
  const repoLines = registry
    .map((e) => `- ${e.name}: audience=${e.promptSpec.audience}; focusAreas=${e.promptSpec.focusAreas.join(", ")}`)
    .join("\n");
  return `
Given this question and these configured repos' audience/focus descriptions, which ONE (if any)
plausibly covers it? Respond with just the repo name, or the literal string "none".

Configured repos:
${repoLines}

Question: ${question}
`.trim();
}

export async function classifyRepoForQuestion(
  question: string,
  registry: RegistryEntry[],
  client?: AnthropicLikeClient,
): Promise<string | null> {
  const anthropic =
    client ??
    (new Anthropic({
      authToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      maxRetries: Number(process.env.ANSWER_MAX_RETRIES ?? 5),
    }) as unknown as AnthropicLikeClient);
  const response = await anthropic.messages.create({
    model: taskModel("CLASSIFY_MODEL", "claude-haiku-4-5"),
    max_tokens: 32,
    messages: [{ role: "user", content: buildClassificationPrompt(question, registry) }],
  });
  const text = response.content.find((b) => b.type === "text")?.text?.trim() ?? "none";
  if (text.toLowerCase() === "none") return null;
  const match = registry.find((e) => e.name === text);
  return match ? match.name : null;
}
