import Anthropic from "@anthropic-ai/sdk";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readRepoKb, renderKb, type KbFile } from "../../src/kb/kbFiles.js";
import { loadRegistry, type RegistryEntry } from "../../src/kb/registry.js";
import type { Turn } from "./slackApi.js";
import type { AnthropicLikeClient } from "../../src/shared/anthropicLike.js";

export function readAllRepoKbs(root: string = process.cwd() + "/knowledge-base"): KbFile[] {
  let names: string[];
  try {
    names = readdirSync(join(root, "repos"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  return names.flatMap((name) => readRepoKb(root, name));
}

export function renderKbForPrompt(files: KbFile[], registry: RegistryEntry[], budget?: number): string {
  const scaledBudget = budget ?? Math.max(600_000, 150_000 * registry.length);
  const index = registry
    .map((e) => `- ${e.name} (${e.sourceRepo}): ${e.promptSpec.audience}`)
    .join("\n");
  const body = renderKb(files, scaledBudget);
  if (body.startsWith("WARNING:")) {
    console.warn(`renderKbForPrompt: over budget (${scaledBudget}) across ${registry.length} repo(s) — falling back to index-only.`);
  }
  return `Configured repos:\n${index}\n\n${body}`;
}

export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
export const NO_KB_MATCH = "NO_KB_MATCH";

const INSTRUCTIONS = `
You are ask-d2e, a Q&A assistant. Answer using ONLY the knowledge base provided.
Rules:
- Ground every claim in the knowledge base. If uncovered, say so plainly rather than guessing.
- When uncovered, begin your reply with ${NO_KB_MATCH} on its own first line, then the plain message.
- Be concise — this is a Slack reply.
- Cite the EXACT source path(s) you used at the end, formatted exactly as they appear
  (e.g. "repos/acme-widgets/03-cloud-functions/query-generation-service.md") — this exact
  string is later parsed to resolve which repo a correction should target, so do not
  paraphrase or shorten it.
Slack formatting (Slack mrkdwn, NOT GitHub Markdown): *single asterisks* for bold, no #
headings, no **double asterisks**; backticks for code; bullet with a leading dash.
`.trim();

export function makeClient(): Anthropic {
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauthToken) {
    return new Anthropic({
      authToken: oauthToken,
      defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
      maxRetries: Number(process.env.ANSWER_MAX_RETRIES ?? 5),
    });
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    return new Anthropic({ apiKey, maxRetries: Number(process.env.ANSWER_MAX_RETRIES ?? 5) });
  }
  throw new Error("Neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set.");
}

export interface AnswerResult {
  text: string;
  covered: boolean;
}

let cachedKbText: string | undefined;

function kbText(): string {
  if (cachedKbText === undefined) {
    const root = process.cwd() + "/knowledge-base";
    const files = readAllRepoKbs(root);
    const registry = (() => {
      try {
        return loadRegistry(root);
      } catch {
        return [];
      }
    })();
    cachedKbText = renderKbForPrompt(files, registry);
  }
  return cachedKbText;
}

export async function answerQuestion(
  question: string,
  history: Turn[] = [],
  client?: AnthropicLikeClient,
): Promise<AnswerResult> {
  const usingOauth = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  const anthropic = client ?? (makeClient() as unknown as AnthropicLikeClient);

  const system = [
    ...(usingOauth ? [{ type: "text" as const, text: CLAUDE_CODE_IDENTITY }] : []),
    { type: "text" as const, text: INSTRUCTIONS },
    { type: "text" as const, text: kbText(), cache_control: { type: "ephemeral" as const } },
  ];

  const messages = [
    ...history.map((t) => ({ role: t.role, content: t.text })),
    { role: "user" as const, content: question },
  ];

  const response = await anthropic.messages.create({
    model: process.env.ANSWER_MODEL ?? process.env.CLAUDE_MODEL ?? "claude-sonnet-4-5",
    max_tokens: 1024,
    system,
    messages,
  });

  const rawText = response.content.find((b) => b.type === "text")?.text ?? "";
  const covered = !rawText.startsWith(NO_KB_MATCH);
  const text = covered ? rawText : rawText.slice(NO_KB_MATCH.length).replace(/^\n+/, "");
  return { text, covered };
}
