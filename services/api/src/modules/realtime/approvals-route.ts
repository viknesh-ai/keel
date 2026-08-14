import type { IncomingMessage, ServerResponse } from "node:http";
import { deliverDecision, pendingWait } from "./approval-waits.js";
import { json, problem, readBody, type Written } from "./http.js";
import { type Actor, sameActor } from "./ownership.js";

/**
 * `POST /rt/v1/approvals/{id}/decide` (doc 05 Part A).
 *
 * This is the widget's endpoint, and it answers exactly one question: did the
 * user who asked for the action confirm it? That is why an `approve`-mode
 * approval is refused here rather than handled. `approve` means a *different*
 * principal, holding a role the requester does not have, decides — and letting
 * the requester's own session settle it through the same door would quietly
 * collapse the two controls into one. The distinction is only real if some
 * request gets turned away, so this one does.
 */

export type RecordDecision = (input: {
  readonly approvalId: string;
  readonly decision: "approved" | "rejected";
  readonly decidedBy: string;
}) => Promise<{ readonly ok: boolean }>;

export async function handleDecide(
  req: IncomingMessage,
  res: ServerResponse,
  input: {
    readonly approvalId: string;
    readonly actor: Actor;
    readonly decidedBy: string;
    readonly recordDecision?: RecordDecision;
  },
): Promise<Written> {
  const wait = pendingWait(input.approvalId);

  // Unknown and not-yours are the same answer. Otherwise a session could probe
  // for live approval ids belonging to other users.
  //
  // "Yours" is the same rule reattaching uses: this session, or a new session
  // for the same identity subject — which is what a page reload produces.
  if (wait === undefined || !sameActor(wait, input.actor)) {
    return problem(res, 404, "no such approval");
  }

  if (wait.mode === "approve") {
    return problem(res, 403, "this approval must be decided by an authorised approver");
  }

  const body = await readBody(req);
  const decision = body["decision"];
  if (decision !== "approved" && decision !== "rejected") {
    return problem(res, 400, "decision must be 'approved' or 'rejected'");
  }

  // The durable record first. If the row is no longer pending — already
  // decided, or lapsed — the run must not be woken, because the answer it would
  // act on was never written down.
  if (input.recordDecision !== undefined) {
    const recorded = await input.recordDecision({
      approvalId: input.approvalId,
      decision,
      decidedBy: input.decidedBy,
    });
    if (!recorded.ok) return problem(res, 409, "this approval is no longer pending");
  }

  const delivered = deliverDecision(input.approvalId, decision);

  // The decision is recorded either way; `resumed` says whether a live run
  // heard it. A client that reconnects after a restart will see false here and
  // read the state back rather than assuming its run woke up.
  return json(res, 200, {
    approval_id: input.approvalId,
    run_id: wait.run_id,
    decision,
    resumed: delivered,
  });
}
