/** Minimal shape of an Anthropic SDK client, narrow enough to stub in tests. */
export interface AnthropicLikeClient {
  messages: { create: (...args: unknown[]) => Promise<{ content: { type: string; text?: string }[] }> };
}
