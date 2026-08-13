import type { AgentLimitError } from "@keel/contracts";
import { addUsage, emptyUsage, type Usage } from "./types.js";

/**
 * Budget accounting: tokens, calls, cost, wall clock (doc 01 §5.1).
 *
 * A reusable accumulator rather than something the runtime hand-rolls, because
 * the same four limits are checked on entry to Planning and Executing and by
 * the per-project monthly ceiling, and three implementations of "have we spent
 * too much" would disagree within a quarter.
 *
 * Exceeding a limit is a normal transition to Failed(AgentLimitError), not an
 * exception (doc 01 §4.3) — so `check` returns the error as a value.
 */

export type Budget = {
  readonly max_cost_usd?: number;
  readonly max_model_calls?: number;
  readonly max_tool_calls?: number;
  readonly max_seconds?: number;
  readonly max_tokens?: number;
};

export type Spend = {
  readonly usage: Usage;
  readonly cost_usd: number;
  readonly model_calls: number;
  readonly tool_calls: number;
  readonly elapsed_ms: number;
};

export class BudgetAccumulator {
  #usage: Usage = emptyUsage();
  #costUsd = 0;
  #modelCalls = 0;
  #toolCalls = 0;
  readonly #startedAt: number;

  /**
   * `now` is injected rather than read from Date.now() inside, so a replay can
   * reproduce a wall-clock limit deterministically. A budget that depends on
   * the real clock cannot be replayed, and replay is what evaluation is built
   * on (doc 01 §4.1).
   */
  constructor(
    private readonly budget: Budget,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.#startedAt = now();
  }

  recordModelCall(usage: Usage, costUsd: number): void {
    this.#usage = addUsage(this.#usage, usage);
    this.#costUsd += costUsd;
    this.#modelCalls += 1;
  }

  recordToolCall(): void {
    this.#toolCalls += 1;
  }

  spend(): Spend {
    return {
      usage: this.#usage,
      cost_usd: this.#costUsd,
      model_calls: this.#modelCalls,
      tool_calls: this.#toolCalls,
      elapsed_ms: this.now() - this.#startedAt,
    };
  }

  /**
   * Returns the error if any limit is exceeded, or undefined.
   *
   * Checked in a fixed order so the reported limit is deterministic when two
   * are breached at once — otherwise the same run replayed could blame a
   * different limit and an evaluation fixture would flap.
   */
  check(): AgentLimitError | undefined {
    const spend = this.spend();

    const exceeded = (
      limit: AgentLimitError["limit"],
      budget: number | undefined,
      consumed: number,
    ): AgentLimitError | undefined =>
      budget !== undefined && consumed > budget
        ? {
            class: "AgentLimitError",
            message: `budget exhausted: ${limit} ${consumed} exceeds ${budget}`,
            limit,
            budget,
            consumed,
          }
        : undefined;

    return (
      exceeded("cost_usd", this.budget.max_cost_usd, spend.cost_usd) ??
      exceeded("model_calls", this.budget.max_model_calls, spend.model_calls) ??
      exceeded("tool_calls", this.budget.max_tool_calls, spend.tool_calls) ??
      exceeded("tokens", this.budget.max_tokens, spend.usage.tokens_in + spend.usage.tokens_out) ??
      exceeded("seconds", this.budget.max_seconds, spend.elapsed_ms / 1000)
    );
  }

  /**
   * Whether one more call of an estimated size would breach the budget.
   *
   * Checking before spending is the point: discovering the cost ceiling after
   * paying for the call that crossed it makes the ceiling advisory.
   */
  wouldExceed(estimate: { costUsd?: number; tokens?: number }): AgentLimitError | undefined {
    const spend = this.spend();

    if (
      this.budget.max_cost_usd !== undefined &&
      spend.cost_usd + (estimate.costUsd ?? 0) > this.budget.max_cost_usd
    ) {
      return {
        class: "AgentLimitError",
        message: "budget would be exhausted by this call: cost_usd",
        limit: "cost_usd",
        budget: this.budget.max_cost_usd,
        consumed: spend.cost_usd + (estimate.costUsd ?? 0),
      };
    }

    if (
      this.budget.max_model_calls !== undefined &&
      spend.model_calls + 1 > this.budget.max_model_calls
    ) {
      return {
        class: "AgentLimitError",
        message: "budget would be exhausted by this call: model_calls",
        limit: "model_calls",
        budget: this.budget.max_model_calls,
        consumed: spend.model_calls + 1,
      };
    }

    const tokens = spend.usage.tokens_in + spend.usage.tokens_out + (estimate.tokens ?? 0);
    if (this.budget.max_tokens !== undefined && tokens > this.budget.max_tokens) {
      return {
        class: "AgentLimitError",
        message: "budget would be exhausted by this call: tokens",
        limit: "tokens",
        budget: this.budget.max_tokens,
        consumed: tokens,
      };
    }

    return undefined;
  }
}
