import { describe, expect, it } from "vitest";
import { BudgetAccumulator } from "../src/budget.js";
import { emptyUsage } from "../src/types.js";

const usage = (tokens_in: number, tokens_out: number) => ({
  ...emptyUsage(),
  tokens_in,
  tokens_out,
});

describe("BudgetAccumulator", () => {
  it("starts clean", () => {
    const budget = new BudgetAccumulator({});

    expect(budget.spend().model_calls).toBe(0);
    expect(budget.check()).toBeUndefined();
  });

  it("accumulates usage, cost and call counts", () => {
    const budget = new BudgetAccumulator({});

    budget.recordModelCall(usage(100, 50), 0.01);
    budget.recordModelCall(usage(200, 75), 0.02);
    budget.recordToolCall();

    const spend = budget.spend();
    expect(spend.usage.tokens_in).toBe(300);
    expect(spend.usage.tokens_out).toBe(125);
    expect(spend.cost_usd).toBeCloseTo(0.03, 6);
    expect(spend.model_calls).toBe(2);
    expect(spend.tool_calls).toBe(1);
  });

  it("returns AgentLimitError as a value — exceeding a budget is a transition, not an exception", () => {
    const budget = new BudgetAccumulator({ max_cost_usd: 0.5 });

    budget.recordModelCall(usage(10, 10), 0.51);

    const error = budget.check();
    expect(error?.class).toBe("AgentLimitError");
    expect(error?.limit).toBe("cost_usd");
    expect(error?.budget).toBe(0.5);
    expect(error?.consumed).toBeCloseTo(0.51, 6);
  });

  it.each([
    ["max_model_calls", { max_model_calls: 1 }, "model_calls"],
    ["max_tokens", { max_tokens: 10 }, "tokens"],
  ] as const)("enforces %s", (_label, limits, expected) => {
    const budget = new BudgetAccumulator(limits);

    budget.recordModelCall(usage(100, 100), 0);
    budget.recordModelCall(usage(100, 100), 0);

    expect(budget.check()?.limit).toBe(expected);
  });

  it("enforces max_tool_calls", () => {
    const budget = new BudgetAccumulator({ max_tool_calls: 1 });

    budget.recordToolCall();
    budget.recordToolCall();

    expect(budget.check()?.limit).toBe("tool_calls");
  });

  it("enforces wall clock against an injected clock, so a replay is deterministic", () => {
    let now = 1_000;
    const budget = new BudgetAccumulator({ max_seconds: 10 }, () => now);

    expect(budget.check()).toBeUndefined();
    now += 11_000;
    expect(budget.check()?.limit).toBe("seconds");
  });

  it("reports limits in a fixed order when several are breached at once", () => {
    const budget = new BudgetAccumulator({ max_cost_usd: 0, max_model_calls: 0, max_tokens: 0 });

    budget.recordModelCall(usage(1, 1), 1);

    // Deterministic, so a replayed run blames the same limit and an evaluation
    // fixture does not flap.
    expect(budget.check()?.limit).toBe("cost_usd");
  });

  it("refuses a call before paying for it", () => {
    const budget = new BudgetAccumulator({ max_cost_usd: 0.5 });

    budget.recordModelCall(usage(10, 10), 0.4);

    expect(budget.wouldExceed({ costUsd: 0.05 })).toBeUndefined();
    expect(budget.wouldExceed({ costUsd: 0.2 })?.limit).toBe("cost_usd");
    // Nothing was spent by asking.
    expect(budget.spend().cost_usd).toBeCloseTo(0.4, 6);
  });

  it("refuses the call that would exceed the model-call ceiling", () => {
    const budget = new BudgetAccumulator({ max_model_calls: 2 });

    budget.recordModelCall(usage(1, 1), 0);
    expect(budget.wouldExceed({})).toBeUndefined();
    budget.recordModelCall(usage(1, 1), 0);
    expect(budget.wouldExceed({})?.limit).toBe("model_calls");
  });
});
