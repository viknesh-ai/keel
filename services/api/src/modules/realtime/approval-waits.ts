import type { LiveRun } from "./registry.js";

/**
 * The in-process half of a suspended run (doc 01 §4.3, doc 05 Part A).
 *
 * The durable half is the `approvals` row: that is the source of truth, and it
 * is what makes a decision survive a restart. What lives here is only the
 * *wake-up* — the open SSE connection that is currently blocked, waiting to be
 * told the answer. That distinction matters. If the process dies, this map dies
 * with it and nothing is lost, because the connection died too; the client
 * reconnects and reads the decided approval back from the database.
 *
 * So this is not a store. It is a doorbell.
 */

export type ApprovalDecision = "approved" | "rejected" | "expired" | "cancelled";

export type ApprovalWait = {
  readonly approval_id: string;
  readonly run_id: string;
  readonly session_id: string;
  /** `confirm` is decidable here; `approve` deliberately is not. */
  readonly mode: "confirm" | "approve";
};

type Entry = ApprovalWait & { settle: (decision: ApprovalDecision) => void };

const waits = new Map<string, Entry>();

export function pendingWait(approvalId: string): ApprovalWait | undefined {
  return waits.get(approvalId);
}

/**
 * Blocks until a decision arrives, the deadline passes, or the run is
 * cancelled.
 *
 * The deadline is not optional. A suspended run holds an open connection, and
 * one that can never be resolved is a leak that looks like patience.
 */
export function waitForDecision(
  run: LiveRun,
  wait: ApprovalWait,
  timeoutMs: number,
): Promise<ApprovalDecision> {
  return new Promise<ApprovalDecision>((resolve) => {
    let done = false;
    const settle = (decision: ApprovalDecision): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      run.controller.signal.removeEventListener("abort", onAbort);
      waits.delete(wait.approval_id);
      resolve(decision);
    };

    const timer = setTimeout(() => settle("expired"), timeoutMs);
    // Node keeps the process alive for a pending timer; a 30-minute approval
    // window should not be the reason a test run or a shutdown hangs.
    timer.unref?.();

    const onAbort = (): void => settle("cancelled");
    run.controller.signal.addEventListener("abort", onAbort, { once: true });
    if (run.cancelled) return settle("cancelled");

    waits.set(wait.approval_id, { ...wait, settle });
  });
}

/**
 * Delivers a decision to a waiting run.
 *
 * Returns false when nobody is waiting, so the endpoint can say so rather than
 * reporting success for a decision that reached nothing.
 */
export function deliverDecision(approvalId: string, decision: ApprovalDecision): boolean {
  const entry = waits.get(approvalId);
  if (entry === undefined) return false;
  entry.settle(decision);
  return true;
}

/** Tests only; the waits are process-global for the same reason runs are. */
export function resetWaits(): void {
  for (const entry of [...waits.values()]) entry.settle("cancelled");
  waits.clear();
}
