import type { KeelError, ToolContract } from "@keel/contracts";
import {
  claimTtlSeconds,
  DEDUPE_TTL_SECONDS,
  type DedupeStore,
  deriveIdempotencyKey,
} from "./idempotency.js";
import { planRecovery } from "./recovery.js";
import {
  type PostCondition,
  type ReadBack,
  type VerificationOutcome,
  verifyPostConditions,
} from "./verification.js";

/**
 * The Tool Executor's control loop (doc 01 §4.2).
 *
 * Dispatch, timeout, retry class, idempotency key, verification — in that
 * order, and the order is the point. Deduplicating *after* dispatch would make
 * the guard decorative, and verifying before the write lands would confirm the
 * previous state.
 *
 * It does not interpret results. It returns what happened; deciding what to say
 * about it belongs elsewhere.
 */

export type ExecuteInput = {
  readonly tool: ToolContract;
  readonly args: Record<string, unknown>;
  /** The actual call. Receives the key so the target can dedupe too. */
  readonly invoke: (
    args: Record<string, unknown>,
    context: { readonly idempotencyKey: string | null; readonly signal: AbortSignal },
  ) => Promise<unknown>;
  readonly dedupe?: DedupeStore;
  readonly postConditions?: readonly PostCondition[];
  readonly readBack?: ReadBack;
  /** Cancellation from the run. Combined with the tool's own timeout. */
  readonly signal?: AbortSignal;
  readonly sleep?: (ms: number) => Promise<void>;
};

export type ExecuteResult =
  | {
      readonly status: "ok";
      readonly value: unknown;
      readonly attempts: number;
      readonly deduplicated: boolean;
      readonly verification: VerificationOutcome | null;
    }
  | { readonly status: "failed"; readonly error: KeelError; readonly attempts: number }
  | { readonly status: "repair"; readonly error: KeelError; readonly reason: string }
  | { readonly status: "fallback"; readonly error: KeelError; readonly reason: string }
  | { readonly status: "cancelled"; readonly attempts: number };

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wraps the caller's signal and the tool's timeout into one.
 *
 * Every external call has a timeout — that is a hard rule — and cancellation
 * has to reach the same place, or a stopped run leaves a request in flight that
 * nobody is waiting for but the backend still serves.
 */
function callSignal(
  timeoutMs: number,
  outer: AbortSignal | undefined,
): {
  signal: AbortSignal;
  done: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const onOuter = () => controller.abort(outer?.reason);
  outer?.addEventListener("abort", onOuter, { once: true });
  if (outer?.aborted ?? false) controller.abort(outer?.reason);

  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    },
  };
}

export async function executeTool(input: ExecuteInput): Promise<ExecuteResult> {
  const { tool } = input;
  const sleep = input.sleep ?? defaultSleep;

  // The key is derived once, before the first attempt. Deriving it per attempt
  // would be identical today and a latent bug the moment an argument is
  // rewritten between tries.
  const derived = deriveIdempotencyKey(tool, input.args);
  const idempotencyKey = derived.ok ? derived.key : null;

  if (tool.idempotency.required && idempotencyKey === null) {
    return {
      status: "failed",
      attempts: 0,
      error: {
        class: "ToolValidationError",
        message: derived.ok ? "no idempotency key" : derived.issue.message,
        tool: tool.name,
        repair_attempted: false,
        issues: [],
      },
    };
  }

  const store = input.dedupe;
  if (store !== undefined && idempotencyKey !== null) {
    const previous = await store.read(idempotencyKey);
    if (previous !== undefined) {
      // Already done. The stored result is returned rather than the call being
      // repeated — which is the entire promise of an idempotency key.
      return {
        status: "ok",
        value: JSON.parse(previous) as unknown,
        attempts: 0,
        deduplicated: true,
        verification: null,
      };
    }

    const claimed = await store.claim(idempotencyKey, claimTtlSeconds(tool.timeout_ms));
    if (!claimed) {
      return {
        status: "failed",
        attempts: 0,
        error: {
          class: "ToolExecutionError",
          message: "an identical call is already in flight",
          tool: tool.name,
          status: 409,
          idempotent: true,
        },
      };
    }
  }

  let attempt = 0;

  try {
    while (true) {
      attempt += 1;

      if (input.signal?.aborted ?? false) return { status: "cancelled", attempts: attempt - 1 };

      const { signal, done } = callSignal(tool.timeout_ms, input.signal);
      try {
        const value = await input.invoke(input.args, { idempotencyKey, signal });

        if (store !== undefined && idempotencyKey !== null) {
          await store.complete(idempotencyKey, JSON.stringify(value ?? null), DEDUPE_TTL_SECONDS);
        }

        const verification =
          input.postConditions === undefined ||
          input.postConditions.length === 0 ||
          input.readBack === undefined
            ? null
            : await verifyPostConditions(input.postConditions, {
                args: input.args,
                readBack: input.readBack,
              });

        return { status: "ok", value, attempts: attempt, deduplicated: false, verification };
      } catch (cause) {
        const error = asKeelError(cause, tool.name, tool.timeout_ms, idempotencyKey !== null);

        if (input.signal?.aborted ?? false) {
          if (store !== undefined && idempotencyKey !== null) await store.release(idempotencyKey);
          return { status: "cancelled", attempts: attempt };
        }

        const plan = planRecovery(error, tool, { attempt, idempotencyKey });

        if (plan.action === "retry") {
          await sleep(plan.delayMs);
          continue;
        }

        // A claim is released on any outcome that is not a completed call, so a
        // later legitimate attempt is not locked out by a failure.
        if (store !== undefined && idempotencyKey !== null) await store.release(idempotencyKey);

        if (plan.action === "repair") return { status: "repair", error, reason: plan.reason };
        if (plan.action === "fallback") return { status: "fallback", error, reason: plan.reason };
        return { status: "failed", error, attempts: attempt };
      } finally {
        done();
      }
    }
  } catch (cause) {
    if (store !== undefined && idempotencyKey !== null) await store.release(idempotencyKey);
    throw cause;
  }
}

/**
 * Narrows an unknown throw into the taxonomy.
 *
 * Anything that is not already a `KeelError` becomes a `ToolExecutionError`
 * rather than being re-thrown: the executor is a boundary, and an unclassified
 * error escaping it is how a run ends with no explanation of why.
 */
function asKeelError(
  cause: unknown,
  tool: string,
  timeoutMs: number,
  idempotent: boolean,
): KeelError {
  if (typeof cause === "object" && cause !== null && "class" in cause) {
    return cause as KeelError;
  }

  const message = cause instanceof Error ? cause.message : String(cause);
  if (message === "timeout") {
    return {
      class: "ToolTimeoutError",
      message: "the call timed out",
      tool,
      timeout_ms: timeoutMs,
      idempotent,
    };
  }

  return { class: "ToolExecutionError", message, tool, idempotent };
}
