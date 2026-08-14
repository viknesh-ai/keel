import type { ReactNode } from "react";

/**
 * Action affordances, graded by risk (doc 05 §E6, doc 03 §C4).
 *
 * The rule these implement: **a mutation never hides inside a conversational
 * sentence.** Information is prose. An action is a bordered card. A destructive
 * action is an emphasised card that states the consequence. An approval carries
 * explicit approve and reject controls.
 *
 * The ordering inside the approval card is fixed and deliberate — action,
 * affected resource, irreversible consequence, cost — because approval fatigue
 * is the real failure mode here. A user who has clicked "Yes" forty times
 * scans; putting the consequence in a trailing clause means they will not read
 * it. The card is a form for a decision, not a chat bubble with a button.
 */

export type RiskTier = "information" | "action" | "destructive";

export type ActionCardProps = {
  readonly risk: RiskTier;
  /** What will happen. A verb phrase, not a sentence about the assistant. */
  readonly action: string;
  /** What it happens to. */
  readonly resource: string;
  /**
   * What cannot be undone. Required at the destructive tier and typed that way:
   * a destructive card whose consequence someone forgot to write is the exact
   * card this component exists to prevent.
   */
  readonly consequence?: string;
  /** Money, quota, or anything else the user is spending. */
  readonly cost?: string;
  readonly labels: ActionLabels;
  readonly children?: ReactNode;
};

export type ActionLabels = {
  readonly action: string;
  readonly resource: string;
  readonly consequence: string;
  readonly cost: string;
  readonly approve: string;
  readonly reject: string;
  readonly pending: string;
};

type DestructiveProps = ActionCardProps & { readonly risk: "destructive" } & {
  readonly consequence: string;
};

export function ActionCard(props: ActionCardProps | DestructiveProps) {
  const { risk, action, resource, consequence, cost, labels, children } = props;

  // Information is prose. Wrapping it in a card would teach the user that every
  // sentence is a decision, which is how the cards stop being read at all.
  if (risk === "information") {
    return <p className="k-action__prose">{action}</p>;
  }

  return (
    <section
      className={`k-action k-action--${risk}`}
      // Grouped, so a screen reader announces the whole decision rather than
      // four unrelated lines with a button after them.
      aria-label={action}
    >
      <dl className="k-action__facts">
        <div className="k-action__fact">
          <dt>{labels.action}</dt>
          <dd className="k-action__value">{action}</dd>
        </div>
        <div className="k-action__fact">
          <dt>{labels.resource}</dt>
          <dd className="k-action__value k-mono">{resource}</dd>
        </div>
        {consequence === undefined ? null : (
          <div className="k-action__fact k-action__fact--consequence">
            <dt>{labels.consequence}</dt>
            <dd className="k-action__value">{consequence}</dd>
          </div>
        )}
        {cost === undefined ? null : (
          <div className="k-action__fact">
            <dt>{labels.cost}</dt>
            <dd className="k-action__value k-mono">{cost}</dd>
          </div>
        )}
      </dl>
      {children}
    </section>
  );
}

export type ApprovalCardProps = ActionCardProps & {
  readonly approvalId: string;
  readonly pending: boolean;
  readonly onApprove: () => void;
  readonly onReject: () => void;
};

export function ApprovalCard({
  approvalId,
  pending,
  onApprove,
  onReject,
  ...card
}: ApprovalCardProps) {
  return (
    <ActionCard {...card}>
      <div className="k-action__controls">
        {/* Plain buttons rather than the Button primitive, and deliberately so:
            this card also renders inside the embedded widget, which is held to
            a 45 KB budget, and pulling Radix's Slot into that bundle to gain
            `asChild` — which nothing here uses — would spend the budget on
            nothing. The class contract is identical either way.

            Reject comes first in the DOM so the keyboard reaches the safe
            control first. Approve is still the visually primary one: the point
            is that confirming is deliberate, not that it is hard. */}
        <button
          type="button"
          className="k-btn k-btn--secondary k-btn--sm k-focus"
          disabled={pending}
          onClick={onReject}
          data-approval={approvalId}
        >
          {card.labels.reject}
        </button>
        <button
          type="button"
          className={`k-btn k-btn--${card.risk === "destructive" ? "danger" : "primary"} k-btn--sm k-focus`}
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={onApprove}
          data-approval={approvalId}
        >
          {pending ? card.labels.pending : card.labels.approve}
        </button>
      </div>
    </ActionCard>
  );
}
