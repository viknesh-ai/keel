import { ActionCard, Badge, EmptyState } from "@keel/ui";
import { Link } from "react-router-dom";
import {
  byWaitingLongest,
  isExpired,
  type PendingApproval,
  refusalReason,
} from "../features/approvals/types.ts";

/**
 * Pending approvals for `approve` mode (doc 05 §E5, doc 03 §C4).
 *
 * `confirm` mode is answered in the widget by the person who asked. This screen
 * is the other half: an approval that requires a *different* principal holding
 * a role. Those two never share a queue, because an operator scanning this list
 * would otherwise be approving their own requests without noticing.
 *
 * Same card as the widget, deliberately. The approver and the requester must be
 * looking at the same four facts in the same order, or "I approved it" and
 * "I asked for it" stop referring to the same thing.
 */

const LABELS = {
  action: "Action",
  resource: "Affects",
  consequence: "Cannot be undone",
  cost: "Cost",
  approve: "Approve",
  reject: "Reject",
  pending: "Sending…",
};

export type ApprovalsViewProps = {
  readonly approvals: readonly PendingApproval[];
  readonly operator: { readonly id: string; readonly roles: readonly string[] };
  readonly now?: Date;
  readonly deciding?: string | null;
  readonly onDecide: (id: string, decision: "approved" | "rejected") => void;
};

export function ApprovalsView({
  approvals,
  operator,
  now = new Date(),
  deciding = null,
  onDecide,
}: ApprovalsViewProps) {
  const queue = byWaitingLongest(approvals);

  if (queue.length === 0) {
    return (
      <EmptyState
        title="Nothing waiting"
        description="Approvals that need a second person appear here. Confirmations the user answers themselves do not."
      />
    );
  }

  return (
    <ul className="k-approvals">
      {queue.map((approval) => {
        const expired = isExpired(approval, now);
        const refusal = expired ? "Expired." : refusalReason(approval, operator);

        return (
          <li key={approval.id} className="k-approvals__item">
            <div className="k-approvals__meta">
              <Badge tone={approval.risk === "critical" ? "danger" : "warning"}>
                {approval.risk}
              </Badge>
              <span className="k-mono">{approval.tool}</span>
              <Link to={`/activity/runs/${approval.run_id}`}>{approval.run_id}</Link>
            </div>

            <ActionCard
              risk={
                approval.risk === "critical" || approval.risk === "high" ? "destructive" : "action"
              }
              action={approval.action}
              resource={approval.resource}
              labels={LABELS}
              {...(approval.consequence === null ? {} : { consequence: approval.consequence })}
              {...(approval.cost === null ? {} : { cost: approval.cost })}
            >
              <div className="k-action__controls">
                {refusal === null ? (
                  <>
                    <button
                      type="button"
                      className="k-btn k-btn--secondary k-btn--sm k-focus"
                      disabled={deciding === approval.id}
                      onClick={() => onDecide(approval.id, "rejected")}
                    >
                      {LABELS.reject}
                    </button>
                    <button
                      type="button"
                      className="k-btn k-btn--danger k-btn--sm k-focus"
                      disabled={deciding === approval.id}
                      onClick={() => onDecide(approval.id, "approved")}
                    >
                      {deciding === approval.id ? LABELS.pending : LABELS.approve}
                    </button>
                  </>
                ) : (
                  // No disabled buttons here: a control that is present but
                  // greyed invites the operator to work out why. The sentence
                  // tells them.
                  <p className="k-approvals__refusal">{refusal}</p>
                )}
              </div>
            </ActionCard>
          </li>
        );
      })}
    </ul>
  );
}

export default function ApprovalsRoute() {
  // Not connected to data yet, and saying so rather than rendering an
  // invented queue: the dashboard's REST surface lands with the rest of the
  // list endpoints. The approvals themselves are real — the record, the decide
  // path and the widget flow are all covered by tests.
  return (
    <EmptyState
      title="Approvals are not wired to the dashboard API yet"
      description="Pending approve-mode approvals will list here. Confirmations are answered in the widget by the person who asked."
    />
  );
}
