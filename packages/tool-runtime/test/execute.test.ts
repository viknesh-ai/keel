import type { ToolContract } from "@keel/contracts";
import { describe, expect, it, vi } from "vitest";
import { executeTool } from "../src/execute/executor.js";
import { deriveIdempotencyKey, InMemoryDedupeStore } from "../src/execute/idempotency.js";
import { planRecovery } from "../src/execute/recovery.js";
import { describeVerificationFailure, verifyPostConditions } from "../src/execute/verification.js";

/**
 * Idempotency, retry and verification (doc 01 §6, doc 02 §1).
 *
 * Three properties, each with a specific failure in mind:
 *
 *   - a double-submitted mutation executes once, because a retried refund that
 *     pays out twice is the canonical version of this bug;
 *   - a destructive call is not retried on timeout, because a timed-out
 *     `cancel_subscription` may well have succeeded;
 *   - a failed post-condition surfaces as a typed error rather than a success
 *     message, because "I cancelled it for you" about a live subscription is
 *     worse than an error.
 */

const tool = (over: Partial<ToolContract> = {}): ToolContract =>
  ({
    name: "cancel_subscription",
    version: 1,
    title: "Cancel a subscription",
    description: "Ends billing for an account.",
    input: { type: "object" },
    output: { type: "object" },
    target: "openapi",
    side_effect: "destructive",
    risk: "critical",
    auth: { kind: "user_action_token" },
    accepts_untrusted_args: false,
    timeout_ms: 5_000,
    retry: { max: 3, backoff: "none", on: ["ToolTimeoutError"] },
    idempotency: { required: true, key_from: ["account_id"] },
    ...over,
  }) as ToolContract;

const ARGS = { account_id: "acct_8891", reason: "moving house" };
const noSleep = async () => undefined;

describe("idempotency keys", () => {
  it("derives the same key for the same declared fields", () => {
    // `reason` is not in key_from, so changing it is the same operation. That
    // is the point of declaring paths rather than hashing everything.
    const a = deriveIdempotencyKey(tool(), ARGS);
    const b = deriveIdempotencyKey(tool(), { ...ARGS, reason: "found it cheaper" });

    expect(a.ok && b.ok && a.key === b.key).toBe(true);
  });

  it("derives a different key for a different account", () => {
    const a = deriveIdempotencyKey(tool(), ARGS);
    const b = deriveIdempotencyKey(tool(), { ...ARGS, account_id: "acct_0001" });

    expect(a.ok && b.ok && a.key === b.key).toBe(false);
  });

  it("does not let two tool versions share a key", () => {
    // The same arguments to v1 and v2 are not the same operation, and deduping
    // across the boundary would be a silent no-op the moment semantics changed.
    const v1 = deriveIdempotencyKey(tool({ version: 1 }), ARGS);
    const v2 = deriveIdempotencyKey(tool({ version: 2 }), ARGS);

    expect(v1.ok && v2.ok && v1.key === v2.key).toBe(false);
  });

  it("refuses to derive a key when a declared field is absent", () => {
    // Defaulting the missing field would make every such call share one key,
    // and two different operations sharing a key is the whole failure.
    const result = deriveIdempotencyKey(tool(), { reason: "x" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.code).toBe("path_absent");
  });

  it("refuses an object as key material", () => {
    const result = deriveIdempotencyKey(
      tool({ idempotency: { required: true, key_from: ["a"] } }),
      {
        a: { nested: true },
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.code).toBe("path_not_scalar");
  });
});

describe("a double-submitted mutation executes once", () => {
  it("returns the first result rather than calling again", async () => {
    const dedupe = new InMemoryDedupeStore();
    const invoke = vi.fn(async () => ({ cancelled: true, at: "2026-08-14T10:00:00Z" }));

    const first = await executeTool({ tool: tool(), args: ARGS, invoke, dedupe });
    const second = await executeTool({ tool: tool(), args: ARGS, invoke, dedupe });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    if (second.status !== "ok") return;
    expect(second.deduplicated).toBe(true);
    expect(second.value).toEqual({ cancelled: true, at: "2026-08-14T10:00:00Z" });
  });

  it("refuses a concurrent identical call rather than racing it", async () => {
    const dedupe = new InMemoryDedupeStore();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const slow = executeTool({
      tool: tool(),
      args: ARGS,
      dedupe,
      invoke: async () => {
        await gate;
        return { ok: true };
      },
    });

    const concurrent = await executeTool({
      tool: tool(),
      args: ARGS,
      dedupe,
      invoke: async () => ({ ok: true }),
    });

    expect(concurrent.status).toBe("failed");
    if (concurrent.status !== "failed") return;
    expect(concurrent.error.class).toBe("ToolExecutionError");

    release();
    await slow;
  });

  it("releases the claim when the call failed, so a real retry is not locked out", async () => {
    const dedupe = new InMemoryDedupeStore();
    let calls = 0;
    const invoke = async () => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      return { ok: true };
    };

    const failed = await executeTool({
      tool: tool({ retry: { max: 0, backoff: "none", on: [] } }),
      args: ARGS,
      invoke,
      dedupe,
    });
    expect(failed.status).toBe("failed");

    const retried = await executeTool({ tool: tool(), args: ARGS, invoke, dedupe });
    expect(retried.status).toBe("ok");
    expect(calls).toBe(2);
  });

  it("still executes a different account", async () => {
    const dedupe = new InMemoryDedupeStore();
    const invoke = vi.fn(async () => ({ ok: true }));

    await executeTool({ tool: tool(), args: ARGS, invoke, dedupe });
    await executeTool({ tool: tool(), args: { ...ARGS, account_id: "acct_2" }, invoke, dedupe });

    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

describe("a destructive call is not retried on timeout", () => {
  it("fails rather than repeating when no key could be derived", async () => {
    // The one that matters. A timed-out cancellation may well have succeeded,
    // and asking again is how a subscription gets cancelled twice.
    const invoke = vi.fn(async () => {
      throw {
        class: "ToolTimeoutError",
        message: "timed out",
        tool: "t",
        timeout_ms: 10,
        idempotent: false,
      };
    });

    const result = await executeTool({
      tool: tool({ idempotency: { required: false } }),
      args: ARGS,
      invoke,
      sleep: noSleep,
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("failed");
  });

  it("does retry a read on timeout, because repeating a read is free", async () => {
    let calls = 0;
    const invoke = async () => {
      calls += 1;
      if (calls < 3) {
        throw {
          class: "ToolTimeoutError",
          message: "timed out",
          tool: "t",
          timeout_ms: 10,
          idempotent: true,
        };
      }
      return { ok: true };
    };

    const result = await executeTool({
      tool: tool({ side_effect: "read", risk: "read", idempotency: { required: false } }),
      args: ARGS,
      invoke,
      sleep: noSleep,
    });

    expect(calls).toBe(3);
    expect(result.status).toBe("ok");
  });

  it("retries a destructive call only when a key was actually derived", async () => {
    // "Required" is a promise about registration. This is a question about the
    // call in hand, and the answer is the derived key, not the flag.
    const plan = planRecovery(
      { class: "ToolTimeoutError", message: "t", tool: "t", timeout_ms: 1, idempotent: true },
      {
        side_effect: "destructive",
        retry: { max: 3, backoff: "none", on: [] },
        idempotency: { required: true },
      },
      { attempt: 1, idempotencyKey: null },
    );

    expect(plan.action).toBe("fail");
    if (plan.action !== "fail") return;
    expect(plan.reason).toContain("no idempotency key");
  });

  it("stops at the retry budget", () => {
    const plan = planRecovery(
      { class: "ToolTimeoutError", message: "t", tool: "t", timeout_ms: 1, idempotent: true },
      {
        side_effect: "read",
        retry: { max: 2, backoff: "none", on: [] },
        idempotency: { required: false },
      },
      { attempt: 2, idempotencyKey: null },
    );

    expect(plan.action).toBe("fail");
    if (plan.action !== "fail") return;
    expect(plan.reason).toContain("budget");
  });

  it("honours Retry-After rather than guessing", () => {
    const plan = planRecovery(
      { class: "RateLimitError", message: "slow down", scope: "tool", retry_after_s: 7 },
      {
        side_effect: "read",
        retry: { max: 3, backoff: "exponential", on: [] },
        idempotency: { required: false },
      },
      { attempt: 1, idempotencyKey: null },
    );

    expect(plan).toEqual({ action: "retry", attempt: 2, delayMs: 7000 });
  });
});

describe("ToolValidationError gets exactly one repair", () => {
  it("asks for a repair the first time", () => {
    const plan = planRecovery(
      {
        class: "ToolValidationError",
        message: "bad args",
        tool: "t",
        issues: [],
        repair_attempted: false,
      },
      {
        side_effect: "read",
        retry: { max: 3, backoff: "none", on: [] },
        idempotency: { required: false },
      },
      { attempt: 1, idempotencyKey: null },
    );

    expect(plan.action).toBe("repair");
  });

  it("stops after the repaired arguments fail too", () => {
    // Otherwise the model and the validator argue until the budget runs out.
    const plan = planRecovery(
      {
        class: "ToolValidationError",
        message: "still bad",
        tool: "t",
        issues: [],
        repair_attempted: true,
      },
      {
        side_effect: "read",
        retry: { max: 3, backoff: "none", on: [] },
        idempotency: { required: false },
      },
      { attempt: 2, idempotencyKey: null },
    );

    expect(plan.action).toBe("fail");
  });
});

describe("post-conditions are read back", () => {
  const conditions = [
    {
      read: "get_subscription",
      args_from: { id: "account_id" },
      path: "status",
      equals: "cancelled",
      description: "the subscription is cancelled",
    },
  ];

  it("passes when the state actually changed", async () => {
    const outcome = await verifyPostConditions(conditions, {
      args: ARGS,
      readBack: async () => ({ status: "cancelled" }),
    });

    expect(outcome).toEqual({ ok: true, checked: 1 });
  });

  it("fails when the backend said 200 but nothing changed", async () => {
    // The failure this exists for: a 200 is evidence a request was accepted,
    // not that the state the user cares about moved.
    const outcome = await verifyPostConditions(conditions, {
      args: ARGS,
      readBack: async () => ({ status: "active" }),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failures[0]).toMatchObject({ expected: "cancelled", actual: "active" });
  });

  it("reads the check's arguments from the mutation's arguments", async () => {
    const seen: unknown[] = [];
    await verifyPostConditions(conditions, {
      args: ARGS,
      readBack: async (_tool, args) => {
        seen.push(args);
        return { status: "cancelled" };
      },
    });

    expect(seen).toEqual([{ id: "acct_8891" }]);
  });

  it("compares strictly, so 0 does not pass for '0'", async () => {
    const outcome = await verifyPostConditions(
      [{ read: "r", args_from: {}, path: "n", equals: 0, description: "count is zero" }],
      { args: {}, readBack: async () => ({ n: "0" }) },
    );

    expect(outcome.ok).toBe(false);
  });

  it("reports every failure, not just the first", async () => {
    const outcome = await verifyPostConditions(
      [
        { read: "r", args_from: {}, path: "a", equals: 1, description: "a is one" },
        { read: "r", args_from: {}, path: "b", equals: 2, description: "b is two" },
      ],
      { args: {}, readBack: async () => ({ a: 9, b: 9 }) },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failures).toHaveLength(2);
  });

  it("surfaces as a sentence that never claims success", async () => {
    const outcome = await verifyPostConditions(conditions, {
      args: ARGS,
      readBack: async () => ({ status: "active" }),
    });

    expect(describeVerificationFailure(outcome)).toBe(
      "The change could not be confirmed: the subscription is cancelled.",
    );
  });

  it("runs the checks through the executor and reports them on the result", async () => {
    const result = await executeTool({
      tool: tool(),
      args: ARGS,
      invoke: async () => ({ accepted: true }),
      postConditions: conditions,
      readBack: async () => ({ status: "active" }),
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // "ok" means the call returned. Whether it *worked* is the verification,
    // and the two are deliberately separate facts.
    expect(result.verification?.ok).toBe(false);
  });
});

describe("cancellation and timeouts reach the call", () => {
  it("hands the invoker a signal that aborts on the tool's timeout", async () => {
    const aborted = await new Promise<boolean>((resolve) => {
      void executeTool({
        tool: tool({ timeout_ms: 10, retry: { max: 0, backoff: "none", on: [] } }),
        args: ARGS,
        invoke: async (_args, ctx) => {
          ctx.signal.addEventListener("abort", () => resolve(true), { once: true });
          return new Promise(() => undefined);
        },
      });
    });

    expect(aborted).toBe(true);
  });

  it("stops before the first attempt when the run was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const invoke = vi.fn(async () => ({ ok: true }));

    const result = await executeTool({
      tool: tool(),
      args: ARGS,
      invoke,
      signal: controller.signal,
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(result.status).toBe("cancelled");
  });

  it("does not retry a call the run cancelled", async () => {
    // Retrying after a stop is the opposite of what the user asked for.
    const controller = new AbortController();
    let calls = 0;

    const result = await executeTool({
      tool: tool({ side_effect: "read", idempotency: { required: false } }),
      args: ARGS,
      signal: controller.signal,
      sleep: noSleep,
      invoke: async () => {
        calls += 1;
        controller.abort();
        throw {
          class: "ToolTimeoutError",
          message: "t",
          tool: "t",
          timeout_ms: 1,
          idempotent: true,
        };
      },
    });

    expect(calls).toBe(1);
    expect(result.status).toBe("cancelled");
  });
});
