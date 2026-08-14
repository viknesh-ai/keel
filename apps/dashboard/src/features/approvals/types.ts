/** Mirrors the `approvals` row (doc 03 §C4, migration 0005). */

export type ApprovalState = "pending" | "approved" | "rejected" | "expired" | "consumed";

export type PendingApproval = {
  readonly id: string;
  readonly run_id: string;
  readonly tool: string;
  readonly risk: "read" | "low" | "high" | "critical";
  readonly mode: "confirm" | "approve";
  readonly state: ApprovalState;
  readonly requested_by: string | null;
  readonly decide_by_role: string | null;
  readonly requested_at: string;
  readonly expires_at: string;
  readonly args: Record<string, unknown>;
  readonly action: string;
  readonly resource: string;
  readonly consequence: string | null;
  readonly cost: string | null;
};

/**
 * Whether this operator may decide this approval.
 *
 * Two conditions, both required, and they are the same two the database
 * enforces: hold the named role, and not be the person who asked. Duplicating
 * the rule in the UI is not the control — the server is — but showing an
 * operator a button that will be refused is its own kind of wrong.
 */
export function canDecide(
  approval: PendingApproval,
  operator: { readonly id: string; readonly roles: readonly string[] },
): boolean {
  if (approval.state !== "pending") return false;
  if (approval.mode !== "approve") return false;
  if (approval.decide_by_role === null) return false;
  if (approval.requested_by === operator.id) return false;
  return operator.roles.includes(approval.decide_by_role);
}

/** Reason the control is unavailable, for the operator to read. */
export function refusalReason(
  approval: PendingApproval,
  operator: { readonly id: string; readonly roles: readonly string[] },
): string | null {
  if (canDecide(approval, operator)) return null;
  if (approval.state !== "pending") return `Already ${approval.state}.`;
  if (approval.requested_by === operator.id) {
    return "You requested this. Someone else has to approve it.";
  }
  if (approval.decide_by_role === null) return "No approver role is configured.";
  return `Requires the ${approval.decide_by_role} role.`;
}

/** Oldest first: the one that has been waiting longest is the urgent one. */
export function byWaitingLongest(
  approvals: readonly PendingApproval[],
): readonly PendingApproval[] {
  return [...approvals].sort((a, b) => a.requested_at.localeCompare(b.requested_at));
}

export function isExpired(approval: PendingApproval, now: Date): boolean {
  return new Date(approval.expires_at).getTime() <= now.getTime();
}
