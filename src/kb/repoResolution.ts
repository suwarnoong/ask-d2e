import Anthropic from "@anthropic-ai/sdk";
import type { RegistryEntry } from "./registry.js";
import type { AnthropicLikeClient } from "../shared/anthropicLike.js";

export function resolveRepoFromCitation(answerText: string): string | null {
  const names = [...new Set([...answerText.matchAll(/repos\/([^/\s]+)\//g)].map((m) => m[1]))];
  return names.length === 1 ? names[0] : null;
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
  const anthropic = client ?? (new Anthropic({ authToken: process.env.CLAUDE_CODE_OAUTH_TOKEN }) as unknown as AnthropicLikeClient);
  const response = await anthropic.messages.create({
    model: process.env.CLAUDE_MODEL ?? "claude-haiku-4-5",
    max_tokens: 32,
    messages: [{ role: "user", content: buildClassificationPrompt(question, registry) }],
  });
  const text = response.content.find((b) => b.type === "text")?.text?.trim() ?? "none";
  if (text.toLowerCase() === "none") return null;
  const match = registry.find((e) => e.name === text);
  return match ? match.name : null;
}
