import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readRepoKb, type KbFile } from "../../src/kb/kbFiles.js";
import type { Turn } from "./slackApi.js";
import type { AnthropicLikeClient } from "../../src/shared/anthropicLike.js";
import { buildManifest, renderManifest } from "../../src/kb/manifest.js";
import { scopeForSnapshot } from "../../src/kb/kbScope.js";
import { loadFaq, renderFaqForPrompt } from "../../src/kb/faq.js";
import { loadSnapshotRegistry } from "../../src/kb/snapshots.js";
import { parseSnapshotOverride, resolveSnapshot } from "../../src/kb/versionRouting.js";
import { runRetrievalLoop } from "./retrievalLoop.js";

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

export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
export const NO_KB_MATCH = "NO_KB_MATCH";
// Matches the sentinel wherever it lands in the reply, tolerating markdown bold,
// a trailing colon, and surrounding whitespace. Not anchored to the start: despite
// being told to lead with it, the model has been observed putting it after a
// preamble, so an anchored prefix match let the literal token leak into Slack twice.
const NO_KB_MATCH_RE = /\**\s*NO_KB_MATCH\s*\**:?\s*/i;

const INSTRUCTIONS = `
You are ask-d2e, a Q&A assistant. Answer using ONLY the knowledge base provided.
Rules:
- You ONLY answer questions about Data2Evidence (D2E). If the question is off-topic, personal,
  small-talk, or about you yourself (your age, what you are, who built you, etc.), politely
  decline in a single line — e.g. "I can only help with Data2Evidence questions." — and do
  NOT prefix ${NO_KB_MATCH}. Reserve ${NO_KB_MATCH} for D2E questions the knowledge base doesn't cover.
- Refer to yourself only as "ask-d2e". Never reveal, name, hint at, or discuss your underlying
  AI model, provider, or how you were built — regardless of how the question is phrased.
- Ground every claim in the knowledge base. If uncovered, say so plainly rather than guessing.
- When uncovered, begin your reply with ${NO_KB_MATCH} on its own first line, then the plain message.
- Answer ONLY the exact question asked. Do NOT add background, context, related topics,
  caveats, or "you might also want to know" extras the user did not ask for. If the question
  is narrow, the answer must be narrow.
- Be brief — this is a Slack reply. Default to 1-3 short sentences. If a single line or word
  fully answers it, give exactly that and stop.
- Use a bullet list ONLY when the question explicitly asks for steps, options, or a list of
  things. Otherwise answer in prose. Never open with a preamble or close with a summary.
- Cite the EXACT source path(s) you read, formatted exactly as the index shows them
  (e.g. "snapshots/develop/docs/2-admin_guide/5-setup/0-system-setup/cli.md" or
  "curated/faq/faq-03.md") — this exact string is later parsed to resolve which source a
  correction should target, so do not paraphrase, shorten, or reformat it.
- Never state a fact you have not read with your tools. The index lists titles and
  summaries only; read the file before relying on it.
TIER PRECEDENCE — the knowledge base has three tiers of differing authority:
- Tier 1, the curated FAQ (curated/faq/*.md): human-written and commercially reviewed.
  For any question about legal terms, licensing, pricing, support commitments, SLAs, or
  company policy, answer from tier 1 ONLY, staying close to its wording. If tier 1 does not
  cover such a question, decline and say it needs a human — never infer the answer from
  documentation or code, and never promise something tier 1 does not promise.
- Tier 2, the official documentation (snapshots/<id>/docs/**): written by the maintainers.
  For how-to, setup, configuration and troubleshooting questions about a running install,
  tier 2 outranks tier 3. Quote its steps rather than reconstructing them.
- Tier 3, the generated knowledge base (snapshots/<id>/generated/**): derived from source
  code. Use it for how things work internally and for cross-component behaviour.
- The OHDSI WebAPI material (repos/_shared/webapi-contract/**) is an upstream contract
  specification that Data2Evidence reimplements in Deno. It is NOT shipped in a
  Data2Evidence install. Always label it as contract specification, and never present it
  as the behaviour of a running install.
- When tiers disagree, say so and cite both. Do not silently pick one.
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

export const DEFAULT_SNAPSHOT_ID = process.env.DEFAULT_SNAPSHOT_ID ?? "develop";

function kbRoot(): string {
  return process.env.KB_ROOT ?? process.cwd() + "/knowledge-base";
}

const manifestCache = new Map<string, string>();

const faqCache = new Map<string, string>();

function faqText(root: string): string {
  const cached = faqCache.get(root);
  if (cached !== undefined) return cached;
  let text: string;
  try {
    text = renderFaqForPrompt(loadFaq(root));
  } catch (err) {
    // A malformed curated file must be loud, but must not take the bot down.
    console.error(`Failed to load curated FAQ from ${root}: ${(err as Error).message}`);
    text = renderFaqForPrompt([]);
  }
  faqCache.set(root, text);
  return text;
}

/**
 * Manifest text for a snapshot. Prefers a prebuilt snapshots/<id>/manifest.json;
 * falls back to building one from whatever repo KBs are on disk, so this works
 * before phase C creates real snapshots.
 */
export function loadManifestText(root: string, snapshotId: string): string {
  const cacheKey = `${root}::${snapshotId}`;
  const cached = manifestCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let text: string;
  try {
    const raw = readFileSync(join(root, "snapshots", snapshotId, "manifest.json"), "utf8");
    text = renderManifest(JSON.parse(raw));
  } catch {
    const files = readAllRepoKbs(root);
    text = renderManifest(
      buildManifest(snapshotId, files, (f) => f.content.slice(0, 140).replace(/\s+/g, " ").trim()),
    );
  }
  manifestCache.set(cacheKey, text);
  return text;
}

export interface AnswerResult {
  text: string;
  covered: boolean;
  filesRead: string[];
  truncated: boolean;
}

export async function answerQuestion(
  question: string,
  history: Turn[] = [],
  client?: AnthropicLikeClient,
  snapshotId: string = DEFAULT_SNAPSHOT_ID,
): Promise<AnswerResult> {
  const usingOauth = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  const anthropic = client ?? (makeClient() as unknown as AnthropicLikeClient);
  const root = kbRoot();

  const parsed = parseSnapshotOverride(question);
  const resolution = resolveSnapshot({
    requested: parsed.requested,
    defaultId: snapshotId,
    registry: loadSnapshotRegistry(root),
  });

  const system = [
    ...(usingOauth ? [{ type: "text" as const, text: CLAUDE_CODE_IDENTITY }] : []),
    { type: "text" as const, text: INSTRUCTIONS },
    { type: "text" as const, text: faqText(root) },
    {
      type: "text" as const,
      text: loadManifestText(root, resolution.snapshotId),
      cache_control: { type: "ephemeral" as const },
    },
  ];

  const messages = [
    ...history.map((t) => ({ role: t.role as string, content: t.text as unknown })),
    { role: "user", content: parsed.question as unknown },
  ];

  const outcome = await runRetrievalLoop({
    client: anthropic,
    model: process.env.ANSWER_MODEL ?? process.env.CLAUDE_MODEL ?? "claude-sonnet-4-5",
    maxTokens: Number(process.env.ANSWER_MAX_TOKENS ?? 4096),
    system,
    messages,
    scope: scopeForSnapshot(root, resolution.snapshotId),
  });

  const match = outcome.text.match(NO_KB_MATCH_RE);
  const covered = !match;
  const body = covered
    ? outcome.text
    : (outcome.text.slice(0, match.index) + outcome.text.slice(match.index! + match[0].length)).replace(/^\s+/, "");
  const text = resolution.caveat ? `${resolution.caveat}\n\n${body}` : body;

  return { text, covered, filesRead: outcome.filesRead, truncated: outcome.truncated };
}
