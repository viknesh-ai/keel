import { describe, expect, it } from "vitest";
import { estimateCostUsd, isLocal, isPriced, priceFor } from "../src/pricing.js";

describe("pricing", () => {
  it("prices a known model from the checked-in table", () => {
    const cost = estimateCostUsd("claude-sonnet-4-5", {
      tokens_in: 1_000_000,
      tokens_out: 0,
      cache_read_tokens: 0,
    });

    expect(cost).toBeCloseTo(3, 6);
  });

  it("bills cache reads at the cache rate, not the input rate", () => {
    const cached = estimateCostUsd("claude-sonnet-4-5", {
      tokens_in: 1_000_000,
      tokens_out: 0,
      cache_read_tokens: 1_000_000,
    });

    expect(cached).toBeCloseTo(0.3, 6);
  });

  it("returns 0 for a local model and reports it as genuinely priced", () => {
    expect(
      estimateCostUsd(
        "qwen2.5:0.5b",
        { tokens_in: 1e6, tokens_out: 1e6, cache_read_tokens: 0 },
        { local: true },
      ),
    ).toBe(0);
    expect(isPriced("qwen2.5:0.5b", { local: true })).toBe(true);
  });

  it("returns 0 for an unknown hosted model but reports it as unpriced", () => {
    // A guessed cost that feeds a budget is worse than an absent one, so the
    // two zeroes are distinguishable.
    expect(
      estimateCostUsd("some-new-model", { tokens_in: 1e6, tokens_out: 0, cache_read_tokens: 0 }),
    ).toBe(0);
    expect(isPriced("some-new-model")).toBe(false);
    expect(priceFor("some-new-model")).toBeUndefined();
  });

  it("recognises local base urls", () => {
    expect(isLocal("http://localhost:11434/v1")).toBe(true);
    expect(isLocal("http://127.0.0.1:8000/v1")).toBe(true);
    expect(isLocal("http://host.docker.internal:11434/v1")).toBe(true);
    expect(isLocal("https://api.anthropic.com/v1")).toBe(false);
  });
});
