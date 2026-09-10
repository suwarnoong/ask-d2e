import Anthropic from "@anthropic-ai/sdk";
import type { RegistryEntry } from "./registry.js";
import type { AnthropicLikeClient } from "../shared/anthropicLike.js";
import { taskModel } from "../shared/config.js";

export function resolveRepoFromCitation(answerText: string): string | null {
  const names = [...new Set([...answerText.matchAll(/repos\/([^/\s]+)\//g)].map((m) => m[1]))];
  return names.length === 1 ? names[0] : null;
}

// True when the answer cites at least one KB source path — i.e. it was grounded in real
// KB content, not a "we don't have that" miss. Used to gate self-heal: an answer that cited
// the KB shouldn't trigger a "doesn't cover that yet" follow-up even if it flagged NO_KB_MATCH.
export function hasKbCitation(answerText: string): boolean {
  return /repos\/[^/\s]+\//.test(answerText);
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
