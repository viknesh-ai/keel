import { type OrgScope, scopedQuery, scopedQueryOne } from "../../db/scope.js";

/**
 * Approvals (doc 03 §C4).
 *
 * The run suspends durably: everything needed to resume it is in this row, so a
 * restarted process picks the run up rather than losing it. Nothing about an
 * approval lives in memory.
 */

export type ApprovalRow = {
  id: string;
  org_id: string;
  run_id: string;
  step_id: string | null;
  tool_version_id: string;
  tool: string;
  args: Record<string, unknown>;
  args_sha256: string;
  risk: string;
  mode: "confirm" | "approve";
  requested_by: string | null;
  decide_by_role: string | null;
  state: "pending" | "approved" | "rejected" | "expired" | "consumed";
  requested_at: Date;
  expires_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  reason: string | null;
  consumed_at: Date | null;
};

export async function requestApproval(
  scope: OrgScope,
  input: {
    runId: string;
    stepId?: string;
    toolVersionId: string;
    tool: string;
    args: Record<string, unknown>;
    argsSha256: string;
    risk: string;
    mode: "confirm" | "approve";
    requestedBy?: string;
    decideByRole?: string;
    expiresInSeconds?: number;
  },
): Promise<ApprovalRow> {
  const row = await scopedQueryOne<ApprovalRow>(
    scope,
    `insert into approvals
       (org_id, run_id, step_id, tool_version_id, tool, args, args_sha256, risk, mode,
        requested_by, decide_by_role, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + ($12 || ' seconds')::interval)
     returning *`,
    [
      scope.orgId,
      input.runId,
      input.stepId ?? null,
      input.toolVersionId,
      input.tool,
      JSON.stringify(input.args),
      input.argsSha256,
      input.risk,
      input.mode,
      input.requestedBy ?? null,
      input.decideByRole ?? null,
      input.expiresInSeconds ?? 1800,
    ],
  );
  if (row === undefined) throw new Error("requestApproval returned no row");
  return row;
}

export async function getApproval(
  scope: OrgScope,
  approvalId: string,
): Promise<ApprovalRow | undefined> {
  return scopedQueryOne<ApprovalRow>(scope, "select * from approvals where id = $1", [approvalId]);
}

export type DecideResult =
  | { readonly ok: true; readonly approval: ApprovalRow }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "already_decided" | "expired" | "wrong_decider";
    };

/**
 * Records a decision.
 *
 * The update is conditional on the row still being pending *and* not past its
 * deadline, evaluated in the database. Reading then writing would let two
 * concurrent decisions both succeed, and an approval decided twice is an audit
 * trail that cannot say who authorised the call.
 *
 * `confirm` and `approve` are kept genuinely distinct: an `approve` decision
 * requires a principal holding the named role, and the asking user cannot
 * satisfy it. Collapsing them would mean "the user clicked yes" counts as an
 * authorization control even when the user is the attacker.
 */
export async function decideApproval(
  scope: OrgScope,
  input: {
    approvalId: string;
    decision: "approved" | "rejected";
    decidedBy: string;
    decidedByRoles?: readonly string[];
    reason?: string;
  },
): Promise<DecideResult> {
  const existing = await getApproval(scope, input.approvalId);
  if (existing === undefined) return { ok: false, reason: "not_found" };
  if (existing.state !== "pending") return { ok: false, reason: "already_decided" };
  if (existing.expires_at.getTime() <= Date.now()) return { ok: false, reason: "expired" };

  if (existing.mode === "approve") {
    const required = existing.decide_by_role;
    const holds = required !== null && (input.decidedByRoles ?? []).includes(required);
    // A different principal, with the right role. The requester approving their
    // own high-risk action is exactly what `approve` mode exists to prevent.
    if (!holds || existing.requested_by === input.decidedBy) {
      return { ok: false, reason: "wrong_decider" };
    }
  }

  const row = await scopedQueryOne<ApprovalRow>(
    scope,
    `update approvals
        set state = $2, decided_by = $3, decided_at = now(), reason = $4
      where id = $1 and state = 'pending' and expires_at > now()
      returning *`,
    [input.approvalId, input.decision, input.decidedBy, input.reason ?? null],
  );

  return row === undefined ? { ok: false, reason: "already_decided" } : { ok: true, approval: row };
}

export type ConsumeResult =
  | { readonly ok: true; readonly approval: ApprovalRow }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "not_approved" | "already_consumed" | "arguments_changed";
    };

/**
 * Consumes an approval to authorise exactly one execution.
 *
 * Two guarantees, both enforced in the same statement so neither can be raced:
 * the approval must still be unconsumed, and the arguments must hash to what
 * the approver was shown. An approved call executed with different arguments is
 * the failure `args_sha256` exists to prevent.
 */
export async function consumeApproval(
  scope: OrgScope,
  input: { approvalId: string; argsSha256: string },
): Promise<ConsumeResult> {
  const existing = await getApproval(scope, input.approvalId);
  if (existing === undefined) return { ok: false, reason: "not_found" };
  if (existing.state === "consumed") return { ok: false, reason: "already_consumed" };
  if (existing.state !== "approved") return { ok: false, reason: "not_approved" };
  if (existing.args_sha256 !== input.argsSha256) return { ok: false, reason: "arguments_changed" };

  const row = await scopedQueryOne<ApprovalRow>(
    scope,
    `update approvals
        set state = 'consumed', consumed_at = now()
      where id = $1 and state = 'approved' and args_sha256 = $2
      returning *`,
    [input.approvalId, input.argsSha256],
  );

  return row === undefined
    ? { ok: false, reason: "already_consumed" }
    : { ok: true, approval: row };
}

/**
 * The expiry sweep.
 *
 * Runs on a schedule. Expiring in a query rather than with a timer means a
 * process that was down over the deadline still expires the approval on its
 * next sweep, instead of leaving a run suspended forever.
 */
export async function sweepExpired(scope: OrgScope): Promise<readonly ApprovalRow[]> {
  return scopedQuery<ApprovalRow>(
    scope,
    `update approvals
        set state = 'expired'
      where state = 'pending' and expires_at <= now()
      returning *`,
  );
}

export async function listPending(scope: OrgScope, runId: string): Promise<readonly ApprovalRow[]> {
  return scopedQuery<ApprovalRow>(
    scope,
    "select * from approvals where run_id = $1 and state = 'pending' order by requested_at",
    [runId],
  );
}
