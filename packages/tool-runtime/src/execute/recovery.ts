import type { ToolContract } from "@keel/contracts";
import { type KeelError, retryAfterSeconds, shouldRetryToolCall } from "@keel/contracts";

/**
 * The Recovery Manager (doc 01 §4.2, §6).
 *
 * Its whole job is to be *less* willing to retry than a naive loop. The rule is
 * fixed and stated in one place:
 *
 *   retryable(error) && tool.idempotent && attempt < tool.retry.max
 *
 * and the second clause is the one that gets dropped in a hurry. A destructive
 * tool without an idempotency key is never retried, full stop: a timed-out
 * `cancel_subscription` may well have succeeded, and asking again is how you
 * cancel it twice.
 */

export type RecoveryPlan =
  | { readonly action: "retry"; readonly attempt: number; readonly delayMs: number }
  /** Re-plan the arguments once, feeding the validation error back. */
  | { readonly action: "repair"; readonly reason: string }
  | { readonly action: "fallback"; readonly reason: string }
  | { readonly action: "fail"; readonly reason: string };

export type ToolRetryFacts = {
  readonly side_effect: ToolContract["side_effect"];
  readonly retry: ToolContract["retry"];
  readonly idempotency: ToolContract["idempotency"];
};

/**
 * Whether this tool may be re-sent at all.
 *
 * A read is safe by definition. Anything that mutates is safe only when a key
 * was actually derived for this call — not when the contract merely says a key
 * is required, because "required" is a promise about registration and this is a
 * question about the call in hand.
 */
export function isRetryableTool(tool: ToolRetryFacts, idempotencyKey: string | null): boolean {
  if (tool.side_effect === "read") return true;
  return idempotencyKey !== null;
}

export function backoffMs(attempt: number, backoff: ToolContract["retry"]["backoff"]): number {
  if (backoff === "none") return 0;
  // Exponential with a ceiling. Retrying instantly against a backend that is
  // already failing makes the outage worse.
  return Math.min(30_000, 2 ** attempt * 250);
}

/**
 * Decides what to do about one failed call.
 *
 * `attempt` is the number of attempts already made, so the first failure
 * arrives as attempt 1.
 */
export function planRecovery(
  error: KeelError,
  tool: ToolRetryFacts,
  context: { readonly attempt: number; readonly idempotencyKey: string | null },
): RecoveryPlan {
  // Exactly one repair. `isRetryable` already refuses a second by reading
  // `repair_attempted`, so this branch cannot loop.
  if (error.class === "ToolValidationError") {
    return error.repair_attempted
      ? { action: "fail", reason: "the repaired arguments were still invalid" }
      : { action: "repair", reason: error.message };
  }

  if (error.class === "ToolUnavailableError") {
    return { action: "fallback", reason: "the target could not be reached" };
  }

  const idempotent = isRetryableTool(tool, context.idempotencyKey);

  if (!shouldRetryToolCall(error, { idempotent, retryMax: tool.retry.max }, context.attempt)) {
    // The reason is spelled out per cause, because "not retried" reads as a bug
    // to whoever is looking at the trace unless it says which rule applied.
    if (!idempotent) {
      return {
        action: "fail",
        reason: `${tool.side_effect} call with no idempotency key — a repeat could apply the change twice`,
      };
    }
    if (context.attempt >= tool.retry.max) {
      return { action: "fail", reason: `retry budget of ${tool.retry.max} exhausted` };
    }
    return { action: "fail", reason: `${error.class} is not retryable` };
  }

  // A rate limiter that told us how long to wait is obeyed rather than guessed
  // at; backing off less than we were asked to is how a soft limit becomes a
  // hard ban.
  const after = retryAfterSeconds(error);
  const delayMs =
    after === undefined ? backoffMs(context.attempt, tool.retry.backoff) : after * 1000;

  return { action: "retry", attempt: context.attempt + 1, delayMs };
}

/**
 * Whether the tool's declared `retry.on` list permits this class.
 *
 * Checked separately from `planRecovery` so that a contract listing a class the
 * runtime would never retry anyway is caught at registration rather than
 * quietly ignored at runtime.
 */
export function retryClassAllowed(tool: ToolRetryFacts, error: KeelError): boolean {
  return tool.retry.on.includes(error.class);
}
