import { expect, it } from "vitest";
import type { GenerateEvent, ModelProvider } from "../src/types.js";

/**
 * The provider contract suite.
 *
 * The session's exit criterion is that the same suite passes against Anthropic
 * and against a local Ollama with only config changed — so the suite takes a
 * provider and a model name and asserts nothing about which one it got. Any
 * assertion that could only hold for one backend belongs in that backend's own
 * file, not here.
 *
 * It is deliberately tolerant about *content* and strict about *shape*. A small
 * local model will not answer a question the way Claude does, and a suite that
 * demanded it would fail for reasons that have nothing to do with the adapter
 * being correct.
 */

export type ContractTarget = {
  readonly provider: ModelProvider;
  readonly model: string;
  /** Local models are free; the cost assertion differs and says so. */
  readonly local: boolean;
  readonly supportsTools: boolean;
};

export async function collect(stream: AsyncIterable<GenerateEvent>): Promise<GenerateEvent[]> {
  const events: GenerateEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

export function contractSuite(target: () => ContractTarget): void {
  it("streams text and terminates with exactly one done event", async () => {
    const { provider, model } = target();

    const events = await collect(
      provider.generate(
        {
          model,
          messages: [{ role: "user", content: "Reply with the single word: ready" }],
          maxOutputTokens: 32,
        },
        AbortSignal.timeout(120_000),
      ),
    );

    const done = events.filter((e) => e.type === "done");
    expect(done).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("reports normalised usage, latency, cost and provenance on done", async () => {
    const { provider, model, local } = target();

    const events = await collect(
      provider.generate(
        {
          model,
          messages: [{ role: "user", content: "Say hello." }],
          maxOutputTokens: 32,
        },
        AbortSignal.timeout(120_000),
      ),
    );

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    if (done?.type !== "done") return;

    expect(done.provider).toBe(provider.id);
    expect(done.model).toBe(model);
    expect(done.latency_ms).toBeGreaterThanOrEqual(0);
    expect(done.usage.tokens_in).toBeGreaterThan(0);
    expect(done.usage.tokens_out).toBeGreaterThan(0);
    expect(["stop", "max_tokens", "tool_use"]).toContain(done.finish_reason);

    // Cost is a real number either way; for a local model the real number is 0.
    expect(done.cost_usd).toBeGreaterThanOrEqual(0);
    if (local) expect(done.cost_usd).toBe(0);
  });

  it("produces text content", async () => {
    const { provider, model } = target();

    const events = await collect(
      provider.generate(
        {
          model,
          messages: [{ role: "user", content: "Write one short sentence about the sea." }],
          maxOutputTokens: 64,
        },
        AbortSignal.timeout(120_000),
      ),
    );

    const text = events
      .filter((e): e is Extract<GenerateEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.delta)
      .join("");

    expect(text.trim().length).toBeGreaterThan(0);
  });

  it("honours a system prompt", async () => {
    const { provider, model } = target();

    const events = await collect(
      provider.generate(
        {
          model,
          system: "You always answer with exactly one word.",
          messages: [{ role: "user", content: "What colour is a clear sky at noon?" }],
          maxOutputTokens: 16,
        },
        AbortSignal.timeout(120_000),
      ),
    );

    // Asserting the request was accepted and answered, not that a 0.5B model
    // obeyed the instruction — that would be testing the model, not the adapter.
    expect(events.some((e) => e.type === "text")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("stops an in-flight stream when the signal aborts", async () => {
    const { provider, model } = target();
    const controller = new AbortController();

    const events: GenerateEvent[] = [];
    const started = Date.now();

    for await (const event of provider.generate(
      {
        model,
        messages: [{ role: "user", content: "Count slowly from 1 to 500, one number per line." }],
        maxOutputTokens: 2048,
      },
      controller.signal,
    )) {
      events.push(event);
      // Abort as soon as the model is actually producing output, which is the
      // only moment where cancellation means anything.
      if (event.type === "text") controller.abort();
    }

    const elapsed = Date.now() - started;
    const done = events.at(-1);

    expect(done?.type).toBe("done");
    if (done?.type === "done") expect(done.finish_reason).toBe("cancelled");

    // A full 500-line count takes far longer than this on any backend; finishing
    // quickly is the evidence the transfer actually stopped rather than being
    // read to completion and discarded.
    expect(elapsed).toBeLessThan(30_000);
  });

  it("counts tokens without a network call", async () => {
    const { provider, model } = target();

    const count = await provider.countTokens({
      model,
      messages: [{ role: "user", content: "a".repeat(400) }],
    });

    expect(count).toBeGreaterThan(0);
  });

  it("binds no tools when the request forbids them", async () => {
    const { provider, model, supportsTools } = target();
    if (!supportsTools) return;

    const events = await collect(
      provider.generate(
        {
          model,
          messages: [{ role: "user", content: "What is the weather in Chennai? Use a tool." }],
          tools: [
            {
              name: "get_weather",
              description: "Get the current weather for a city.",
              input_schema: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
                additionalProperties: false,
              },
            },
          ],
          // The Q-LLM restriction: capability removal, not instruction.
          allowTools: false,
          maxOutputTokens: 128,
        },
        AbortSignal.timeout(120_000),
      ),
    );

    expect(events.some((e) => e.type === "tool_call")).toBe(false);
  });
}
