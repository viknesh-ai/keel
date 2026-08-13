/**
 * The model abstraction from docs/architecture/01 §5.
 *
 * Four non-negotiables, all of which show up in these types rather than in a
 * style guide:
 *
 *  1. `AbortSignal` on every method. A user pressing stop must actually stop an
 *     in-flight stream, not merely stop rendering it — the tokens are still
 *     being paid for either way.
 *  2. No provider type leaks above this interface. Nothing downstream should be
 *     able to tell Anthropic from Ollama, which is what makes the router's
 *     choice a configuration decision rather than a code change.
 *  3. Provider errors are mapped into the taxonomy in @keel/contracts. See
 *     errors.ts.
 *  4. Failover is off by default. See router.ts.
 */

export type TaskClass =
  | "intent.classify"
  | "tool.select"
  | "plan.complex"
  | "extract.untrusted"
  | "respond.compose"
  | "vision.describe"
  | "embed.document"
  | "embed.query";

export type Capability = "tools" | "vision" | "streaming" | "structured" | "embeddings" | "cache";

export type Role = "system" | "user" | "assistant" | "tool";

export type Message = {
  readonly role: Role;
  readonly content: string;
  /** Set on role: "tool" so the provider can correlate the result. */
  readonly tool_call_id?: string;
  readonly name?: string;
};

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  /** JSON Schema, as emitted by @keel/contracts. */
  readonly input_schema: Record<string, unknown>;
};

export type GenerateRequest = {
  readonly model: string;
  readonly messages: readonly Message[];
  readonly system?: string;
  readonly tools?: readonly ToolDefinition[];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  /**
   * The Q-LLM restriction from doc 01 §5.1: an `extract.untrusted` call binds
   * no tools at all. Capability restriction is the mitigation, so it is a
   * property of the request rather than a convention the caller remembers.
   */
  readonly allowTools?: boolean;
};

/** Normalised across providers. `finish_reason` in particular is not passed through. */
export type FinishReason =
  | "stop"
  | "max_tokens"
  | "tool_use"
  | "content_filter"
  | "cancelled"
  | "error";

export type Usage = {
  readonly tokens_in: number;
  readonly tokens_out: number;
  /** Providers that report cache hits populate these; others leave them at 0. */
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
};

export type ToolCall = {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
};

/**
 * The stream. Deliberately a small closed union rather than provider-shaped
 * chunks: everything above this layer pattern-matches on it, and a new provider
 * must map onto it rather than widen it.
 */
export type GenerateEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "tool_call"; readonly call: ToolCall }
  | {
      readonly type: "done";
      readonly finish_reason: FinishReason;
      readonly usage: Usage;
      readonly latency_ms: number;
      readonly cost_usd: number;
      readonly provider: string;
      readonly model: string;
    };

export type StructuredRequest = {
  readonly model: string;
  readonly messages: readonly Message[];
  readonly system?: string;
  readonly schema: Record<string, unknown>;
  readonly maxOutputTokens?: number;
};

export type Structured<T> = {
  readonly value: T;
  readonly usage: Usage;
  readonly latency_ms: number;
  readonly cost_usd: number;
  readonly provider: string;
  readonly model: string;
  readonly finish_reason: FinishReason;
};

export type EmbedRequest = {
  readonly model: string;
  readonly input: readonly string[];
};

export type EmbedResult = {
  readonly embeddings: readonly (readonly number[])[];
  readonly usage: Usage;
  readonly latency_ms: number;
  readonly cost_usd: number;
  readonly provider: string;
  readonly model: string;
};

export type TokenCountInput = {
  readonly model: string;
  readonly messages: readonly Message[];
};

export interface ModelProvider {
  readonly id: string;
  readonly capabilities: ReadonlySet<Capability>;
  generate(req: GenerateRequest, signal: AbortSignal): AsyncIterable<GenerateEvent>;
  structured<T>(req: StructuredRequest, signal: AbortSignal): Promise<Structured<T>>;
  embed(req: EmbedRequest, signal: AbortSignal): Promise<EmbedResult>;
  countTokens(input: TokenCountInput): Promise<number>;
}

export const emptyUsage = (): Usage => ({
  tokens_in: 0,
  tokens_out: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
});

export const addUsage = (a: Usage, b: Usage): Usage => ({
  tokens_in: a.tokens_in + b.tokens_in,
  tokens_out: a.tokens_out + b.tokens_out,
  cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
  cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens,
});
