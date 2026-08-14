import { ProviderError } from "../errors.js";
import { estimateCostUsd } from "../pricing.js";
import {
  type Capability,
  type EmbedRequest,
  type EmbedResult,
  emptyUsage,
  type FinishReason,
  type GenerateEvent,
  type GenerateRequest,
  type ModelProvider,
  type Structured,
  type StructuredRequest,
  type TokenCountInput,
  type Usage,
} from "../types.js";

/**
 * The Anthropic adapter.
 *
 * Written against the Messages API directly rather than the SDK: this package
 * must not leak a provider type above the ModelProvider interface, and taking
 * the SDK's types as our own is precisely how that leak happens. The wire
 * format is stable and the mapping is small.
 */

export type AnthropicOptions = {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly version?: string;
};

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_TIMEOUT_MS = 120_000;
const API_VERSION = "2023-06-01";

type StreamEvent = {
  type: string;
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  content_block?: { type?: string; id?: string; name?: string };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { output_tokens?: number };
  index?: number;
};

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic";
  readonly capabilities: ReadonlySet<Capability> = new Set([
    "tools",
    "vision",
    "streaming",
    "structured",
    "cache",
  ]);

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #version: string;

  constructor(options: AnthropicOptions) {
    if (options.apiKey === "") throw new Error("AnthropicProvider requires an api key");
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#version = options.version ?? API_VERSION;
  }

  async #post(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]);

    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.#apiKey,
          "anthropic-version": this.#version,
        },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (cause) {
      if (
        cause instanceof Error &&
        (cause.name === "AbortError" || cause.name === "TimeoutError")
      ) {
        throw cause;
      }
      throw new ProviderError({
        provider: this.id,
        model: "",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      const retryAfter = response.headers.get("retry-after");
      throw new ProviderError({
        provider: this.id,
        model: "",
        status: response.status,
        message: text.slice(0, 500),
        ...(retryAfter === null ? {} : { retryAfterSeconds: Number(retryAfter) }),
      });
    }

    return response;
  }

  async *generate(req: GenerateRequest, signal: AbortSignal): AsyncIterable<GenerateEvent> {
    const startedAt = Date.now();

    const tools =
      req.allowTools === false || req.tools === undefined || req.tools.length === 0
        ? undefined
        : req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema,
          }));

    const response = await this.#post(
      "/messages",
      {
        model: req.model,
        // Anthropic requires max_tokens. A missing value is a caller mistake we
        // paper over with a sane bound rather than a 400 the user never sees.
        max_tokens: req.maxOutputTokens ?? 4096,
        messages: req.messages
          .filter((m) => m.role !== "system")
          .map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
          })),
        ...(req.system === undefined ? {} : { system: req.system }),
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
        ...(tools === undefined ? {} : { tools }),
        stream: true,
      },
      signal,
    );

    const body = response.body;
    if (body === null) {
      throw new ProviderError({
        provider: this.id,
        model: req.model,
        message: "provider returned no response body",
      });
    }

    let usage: Usage = emptyUsage();
    let finishReason: FinishReason = "stop";
    const blocks = new Map<number, { id: string; name: string; json: string }>();

    try {
      for await (const raw of parseSse(body, signal)) {
        const event = JSON.parse(raw) as StreamEvent;

        if (event.type === "message_start" && event.message?.usage !== undefined) {
          usage = {
            tokens_in: event.message.usage.input_tokens ?? 0,
            tokens_out: event.message.usage.output_tokens ?? 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
          };
        }

        if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          blocks.set(event.index ?? 0, {
            id: event.content_block.id ?? "",
            name: event.content_block.name ?? "",
            json: "",
          });
        }

        if (event.type === "content_block_delta") {
          if (event.delta?.type === "text_delta" && event.delta.text !== undefined) {
            yield { type: "text", delta: event.delta.text };
          }
          if (event.delta?.type === "input_json_delta" && event.delta.partial_json !== undefined) {
            const existing = blocks.get(event.index ?? 0);
            if (existing !== undefined) existing.json += event.delta.partial_json;
          }
        }

        if (event.type === "message_delta") {
          if (event.delta?.stop_reason !== undefined) {
            finishReason = normaliseFinish(event.delta.stop_reason);
          }
          if (event.usage?.output_tokens !== undefined) {
            usage = { ...usage, tokens_out: event.usage.output_tokens };
          }
        }
      }
    } catch (cause) {
      if (signal.aborted) {
        yield {
          type: "done",
          finish_reason: "cancelled",
          usage,
          latency_ms: Date.now() - startedAt,
          cost_usd: estimateCostUsd(req.model, usage),
          provider: this.id,
          model: req.model,
        };
        return;
      }
      throw cause;
    }

    // Cancelling the reader ends the stream *cleanly* — `done: true`, no throw —
    // so an aborted call falls out of the loop here rather than through the
    // catch above. Without this check the run would be recorded as a normal
    // completion, and a cancelled run that claims it finished is a trace that
    // lies about what happened.
    if (signal.aborted) {
      yield {
        type: "done",
        finish_reason: "cancelled",
        usage,
        latency_ms: Date.now() - startedAt,
        cost_usd: estimateCostUsd(req.model, usage),
        provider: this.id,
        model: req.model,
      };
      return;
    }

    for (const [, block] of [...blocks].sort(([a], [b]) => a - b)) {
      yield {
        type: "tool_call",
        call: { id: block.id, name: block.name, arguments: safeParseArgs(block.json) },
      };
    }

    yield {
      type: "done",
      finish_reason: blocks.size > 0 ? "tool_use" : finishReason,
      usage,
      latency_ms: Date.now() - startedAt,
      cost_usd: estimateCostUsd(req.model, usage),
      provider: this.id,
      model: req.model,
    };
  }

  /**
   * Structured output via a single-tool forced call, which is Anthropic's
   * supported route and is more reliable than asking for JSON in prose.
   */
  async structured<T>(req: StructuredRequest, signal: AbortSignal): Promise<Structured<T>> {
    const startedAt = Date.now();

    const response = await this.#post(
      "/messages",
      {
        model: req.model,
        max_tokens: req.maxOutputTokens ?? 4096,
        messages: req.messages.map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content,
        })),
        ...(req.system === undefined ? {} : { system: req.system }),
        tools: [{ name: "result", description: "Return the result.", input_schema: req.schema }],
        tool_choice: { type: "tool", name: "result" },
      },
      signal,
    );

    const body = (await response.json()) as {
      content?: { type: string; input?: unknown }[];
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const toolUse = body.content?.find((block) => block.type === "tool_use");
    if (toolUse?.input === undefined) {
      throw new ProviderError({
        provider: this.id,
        model: req.model,
        message: "model did not return the structured result",
      });
    }

    const usage: Usage = {
      tokens_in: body.usage?.input_tokens ?? 0,
      tokens_out: body.usage?.output_tokens ?? 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };

    return {
      value: toolUse.input as T,
      usage,
      latency_ms: Date.now() - startedAt,
      cost_usd: estimateCostUsd(req.model, usage),
      provider: this.id,
      model: req.model,
      finish_reason: normaliseFinish(body.stop_reason ?? "end_turn"),
    };
  }

  /**
   * Anthropic has no embeddings endpoint, and pretending otherwise would fail
   * at runtime in a confusing way. `capabilities` does not include "embeddings",
   * so the router will not select this provider for an embed task class.
   */
  async embed(_req: EmbedRequest, _signal: AbortSignal): Promise<EmbedResult> {
    throw new ProviderError({
      provider: this.id,
      model: _req.model,
      message: "anthropic exposes no embeddings endpoint — route embed.* to a local provider",
    });
  }

  async countTokens(input: TokenCountInput): Promise<number> {
    const characters = input.messages.reduce((sum, m) => sum + m.content.length, 0);
    return Math.ceil(characters / 4);
  }
}

function normaliseFinish(raw: string): FinishReason {
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "max_tokens";
    case "tool_use":
      return "tool_use";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}

function safeParseArgs(raw: string): Record<string, unknown> {
  if (raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) yield trimmed.slice(5).trim();
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
