import { ProviderError } from "../errors.js";
import { estimateCostUsd, isLocal } from "../pricing.js";
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
 * The generic OpenAI-compatible adapter.
 *
 * Targets the `/v1/chat/completions` shape, which Ollama, vLLM, LiteLLM,
 * OpenRouter, Together and OpenAI itself all speak. The requirement is that it
 * works against Ollama and vLLM *unmodified* — so nothing here special-cases a
 * vendor, and every deviation is handled by feature-detecting the response
 * rather than by checking a base URL.
 */

export type OpenAiCompatibleOptions = {
  readonly id: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  /** Every external call has a timeout (CLAUDE.md hard rule 7). */
  readonly timeoutMs?: number;
  readonly capabilities?: readonly Capability[];
};

const DEFAULT_TIMEOUT_MS = 120_000;

type ChatChoiceDelta = {
  content?: string | null;
  tool_calls?: {
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
};

type ChatChunk = {
  choices?: { delta?: ChatChoiceDelta; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
};

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly capabilities: ReadonlySet<Capability>;
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #timeoutMs: number;
  readonly #local: boolean;

  constructor(options: OpenAiCompatibleOptions) {
    this.id = options.id;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#local = isLocal(options.baseUrl);
    this.capabilities = new Set(
      options.capabilities ?? ["tools", "streaming", "structured", "embeddings"],
    );
  }

  /**
   * Combines the caller's signal with a timeout, so a hung provider cannot pin
   * a run open forever and a user's cancel still wins immediately.
   */
  #signal(signal: AbortSignal): { signal: AbortSignal; dispose: () => void } {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    return { signal: combined, dispose: () => undefined };
  }

  async #post(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    const { signal: combined } = this.#signal(signal);

    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.#apiKey === undefined ? {} : { authorization: `Bearer ${this.#apiKey}` }),
        },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (cause) {
      // A cancel propagates untouched; anything else is a provider failure.
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

    const messages = [
      ...(req.system === undefined ? [] : [{ role: "system", content: req.system }]),
      ...req.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.tool_call_id === undefined ? {} : { tool_call_id: m.tool_call_id }),
      })),
    ];

    // allowTools === false binds no tools at all — the Q-LLM restriction. The
    // field is omitted rather than sent empty, because some servers treat an
    // empty array as "tools are available, none defined" and still emit calls.
    const tools =
      req.allowTools === false || req.tools === undefined || req.tools.length === 0
        ? undefined
        : req.tools.map((t) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.input_schema,
            },
          }));

    const response = await this.#post(
      "/chat/completions",
      {
        model: req.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(req.maxOutputTokens === undefined ? {} : { max_tokens: req.maxOutputTokens }),
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
        ...(tools === undefined ? {} : { tools }),
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
    const partialCalls = new Map<number, { id: string; name: string; args: string }>();

    try {
      for await (const chunk of parseSse(body, signal)) {
        if (chunk === "[DONE]") break;

        const parsed = JSON.parse(chunk) as ChatChunk;

        if (parsed.usage != null) {
          usage = {
            tokens_in: parsed.usage.prompt_tokens ?? 0,
            tokens_out: parsed.usage.completion_tokens ?? 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
          };
        }

        const choice = parsed.choices?.[0];
        if (choice === undefined) continue;

        const delta = choice.delta?.content;
        if (typeof delta === "string" && delta !== "") {
          yield { type: "text", delta };
        }

        for (const call of choice.delta?.tool_calls ?? []) {
          const existing = partialCalls.get(call.index) ?? { id: "", name: "", args: "" };
          partialCalls.set(call.index, {
            id: call.id ?? existing.id,
            name: call.function?.name ?? existing.name,
            args: existing.args + (call.function?.arguments ?? ""),
          });
        }

        if (choice.finish_reason != null) {
          finishReason = normaliseFinish(choice.finish_reason);
        }
      }
    } catch (cause) {
      if (signal.aborted) {
        yield {
          type: "done",
          finish_reason: "cancelled",
          usage,
          latency_ms: Date.now() - startedAt,
          cost_usd: estimateCostUsd(req.model, usage, { local: this.#local }),
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
        cost_usd: estimateCostUsd(req.model, usage, { local: this.#local }),
        provider: this.id,
        model: req.model,
      };
      return;
    }

    for (const [, call] of [...partialCalls].sort(([a], [b]) => a - b)) {
      yield {
        type: "tool_call",
        call: {
          id: call.id === "" ? `call_${call.name}` : call.id,
          name: call.name,
          // A model can emit malformed JSON; that is a ToolValidationError
          // upstream, not a crash here.
          arguments: safeParseArgs(call.args),
        },
      };
    }

    yield {
      type: "done",
      finish_reason: partialCalls.size > 0 ? "tool_use" : finishReason,
      usage,
      latency_ms: Date.now() - startedAt,
      cost_usd: estimateCostUsd(req.model, usage, { local: this.#local }),
      provider: this.id,
      model: req.model,
    };
  }

  async structured<T>(req: StructuredRequest, signal: AbortSignal): Promise<Structured<T>> {
    const startedAt = Date.now();

    const response = await this.#post(
      "/chat/completions",
      {
        model: req.model,
        messages: [
          ...(req.system === undefined ? [] : [{ role: "system", content: req.system }]),
          ...req.messages.map((m) => ({ role: m.role, content: m.content })),
        ],
        // Ollama and vLLM both accept json_schema; servers that only understand
        // json_object still return parseable JSON, which is why the parse below
        // is defensive rather than assuming the schema was enforced.
        response_format: {
          type: "json_schema",
          json_schema: { name: "result", schema: req.schema },
        },
        ...(req.maxOutputTokens === undefined ? {} : { max_tokens: req.maxOutputTokens }),
        stream: false,
      },
      signal,
    );

    const body = (await response.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const content = body.choices?.[0]?.message?.content ?? "";
    const usage: Usage = {
      tokens_in: body.usage?.prompt_tokens ?? 0,
      tokens_out: body.usage?.completion_tokens ?? 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };

    let value: T;
    try {
      value = JSON.parse(content) as T;
    } catch {
      throw new ProviderError({
        provider: this.id,
        model: req.model,
        message: `structured output was not valid JSON: ${content.slice(0, 200)}`,
      });
    }

    return {
      value,
      usage,
      latency_ms: Date.now() - startedAt,
      cost_usd: estimateCostUsd(req.model, usage, { local: this.#local }),
      provider: this.id,
      model: req.model,
      finish_reason: normaliseFinish(body.choices?.[0]?.finish_reason ?? "stop"),
    };
  }

  async embed(req: EmbedRequest, signal: AbortSignal): Promise<EmbedResult> {
    const startedAt = Date.now();

    const response = await this.#post(
      "/embeddings",
      { model: req.model, input: [...req.input] },
      signal,
    );

    const body = (await response.json()) as {
      data?: { embedding: number[] }[];
      usage?: { prompt_tokens?: number };
    };

    const usage: Usage = {
      tokens_in: body.usage?.prompt_tokens ?? 0,
      tokens_out: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };

    return {
      embeddings: (body.data ?? []).map((d) => d.embedding),
      usage,
      latency_ms: Date.now() - startedAt,
      cost_usd: estimateCostUsd(req.model, usage, { local: this.#local }),
      provider: this.id,
      model: req.model,
    };
  }

  /**
   * An estimate, and named as one. The OpenAI-compatible surface exposes no
   * tokenizer endpoint, so this is ~4 characters per token — good enough for a
   * pre-flight budget check, not good enough to bill from. Actual usage always
   * comes back from the provider on the `done` event.
   */
  async countTokens(input: TokenCountInput): Promise<number> {
    const characters = input.messages.reduce((sum, m) => sum + m.content.length, 0);
    return Math.ceil(characters / 4);
  }
}

function normaliseFinish(raw: string): FinishReason {
  switch (raw) {
    case "stop":
    case "end_turn":
      return "stop";
    case "length":
    case "max_tokens":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
    case "tool_use":
      return "tool_use";
    case "content_filter":
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

/** Minimal SSE reader. Yields each `data:` payload. */
async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Releasing the reader on abort is what actually stops the transfer; without
  // it the socket keeps draining and the tokens keep being paid for.
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
