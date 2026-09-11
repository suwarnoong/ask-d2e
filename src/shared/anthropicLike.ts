/**
 * Minimal shape of an Anthropic SDK client, narrow enough to stub in tests.
 *
 * Every field beyond `type` is optional: a text block carries `text`, a
 * `tool_use` block carries `id`, `name` and `input`. Keeping them optional on
 * one block type — rather than a discriminated union — lets existing callers
 * that only read `text` stay unchanged.
 */
export interface AnthropicLikeBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface AnthropicLikeResponse {
  content: AnthropicLikeBlock[];
  /** "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" */
  stop_reason?: string;
}

export interface AnthropicLikeClient {
  messages: { create: (...args: unknown[]) => Promise<AnthropicLikeResponse> };
}
