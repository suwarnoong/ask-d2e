import { KB_TOOL_DEFS, executeKbTool } from "./kbTools.js";
import type { KbScope } from "../../src/kb/kbScope.js";
import type {
  AnthropicLikeClient,
  AnthropicLikeBlock,
  AnthropicLikeResponse,
} from "../../src/shared/anthropicLike.js";

export interface RetrievalBudget {
  /** Maximum model calls before the loop is cut off. */
  maxTurns: number;
  /** Maximum cumulative bytes of tool output before the loop is cut off. */
  maxBytes: number;
}

/**
 * Read lazily rather than captured at module load: tests (and any runtime that
 * sets configuration after import) must be able to change these. A module-level
 * const would freeze whatever the environment held at first import.
 */
export function defaultBudget(): RetrievalBudget {
  return {
    maxTurns: Number(process.env.RETRIEVAL_MAX_TURNS ?? 8),
    maxBytes: Number(process.env.RETRIEVAL_MAX_BYTES ?? 400_000),
  };
}

export interface RetrievalOutcome {
  text: string;
  turns: number;
  bytesRead: number;
  filesRead: string[];
  truncated: boolean;
}

export interface RetrievalOptions {
  client: AnthropicLikeClient;
  model: string;
  maxTokens: number;
  system: unknown[];
  messages: { role: string; content: unknown }[];
  scope: KbScope;
  budget?: RetrievalBudget;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

function textOf(blocks: AnthropicLikeBlock[]): string {
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("")
    .trim();
}

const TRUNCATION_NOTE =
  "You have reached your search budget. Answer now from what you have already read. " +
  "Say explicitly that your search was truncated, and cite only files you actually read.";

interface ToolTurn {
  blocks: ToolResultBlock[];
  bytes: number;
  pathsRead: string[];
}

/** One model call with the KB tools offered. */
async function askWithTools(
  options: RetrievalOptions,
  messages: { role: string; content: unknown }[],
): Promise<AnthropicLikeResponse> {
  return options.client.messages.create({
    model: options.model,
    max_tokens: options.maxTokens,
    system: options.system,
    messages,
    tools: KB_TOOL_DEFS,
  });
}

/** Executes every tool_use block of one assistant turn, in order. */
function toolTurn(toolUses: AnthropicLikeBlock[], scope: KbScope): ToolTurn {
  const blocks: ToolResultBlock[] = [];
  const pathsRead: string[] = [];
  let bytes = 0;
  for (const use of toolUses) {
    const result = executeKbTool(use.name ?? "", use.input ?? {}, scope);
    bytes += result.bytes;
    if (use.name === "read_kb_file" && !result.isError) {
      const path = typeof use.input?.path === "string" ? use.input.path : null;
      if (path && !pathsRead.includes(path)) pathsRead.push(path);
    }
    blocks.push({
      type: "tool_result",
      tool_use_id: use.id as string,
      content: result.content,
      is_error: result.isError,
    });
  }
  return { blocks, bytes, pathsRead };
}

/** The final budget-exhausted call, made without tools so the model must answer. */
async function answerWithoutTools(
  options: RetrievalOptions,
  messages: { role: string; content: unknown }[],
): Promise<string> {
  const final = await options.client.messages.create({
    model: options.model,
    max_tokens: options.maxTokens,
    system: options.system,
    messages,
  });
  return textOf(final.content ?? []);
}

export async function runRetrievalLoop(options: RetrievalOptions): Promise<RetrievalOutcome> {
  const budget = options.budget ?? defaultBudget();
  const messages = [...options.messages];
  const filesRead: string[] = [];

  let turns = 0;
  let bytesRead = 0;
  let truncated = false;
  let lastText = "";

  while (turns < budget.maxTurns) {
    const response = await askWithTools(options, messages);
    turns++;

    const blocks = response.content ?? [];
    lastText = textOf(blocks);

    const toolUses = blocks.filter((b) => b.type === "tool_use" && typeof b.id === "string");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      return { text: lastText, turns, bytesRead, filesRead, truncated: false };
    }

    const turn = toolTurn(toolUses, options.scope);
    bytesRead += turn.bytes;
    for (const path of turn.pathsRead) {
      if (!filesRead.includes(path)) filesRead.push(path);
    }

    messages.push({ role: "assistant", content: blocks });
    messages.push({ role: "user", content: turn.blocks });

    if (bytesRead >= budget.maxBytes) {
      truncated = true;
      break;
    }
  }

  if (turns >= budget.maxTurns) truncated = true;

  // Budget exhausted: ask once more with no tools, so the caller always gets text.
  messages.push({ role: "user", content: TRUNCATION_NOTE });
  const finalText = await answerWithoutTools(options, messages);
  turns++;

  return { text: finalText || lastText, turns, bytesRead, filesRead, truncated };
}
