import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ActionCard, type ActionLabels, ApprovalCard } from "../src/approval.js";

/**
 * The approval card and the three risk tiers (doc 05 §E6, doc 03 §C4).
 *
 * The property under test is legibility of a decision, so the assertions are
 * about *order* and *distinguishability* rather than appearance. A card that
 * renders every fact but buries the consequence last has failed at the only
 * thing it exists for.
 */

const labels: ActionLabels = {
  action: "Action",
  resource: "Affects",
  consequence: "Cannot be undone",
  cost: "Cost",
  approve: "Approve",
  reject: "Reject",
  pending: "Submitting…",
};

const card = {
  action: "Cancel the subscription",
  resource: "acct_8891 · Northwind Traders",
  consequence: "Billing stops immediately and the plan cannot be restored at this price.",
  cost: "£0.00",
  labels,
};

describe("the four facts appear in the required order", () => {
  it("states action, resource, consequence, then cost", () => {
    // Doc 03 §C4 fixes this order. Approval fatigue is the failure mode: a user
    // who has clicked yes forty times scans, and a consequence in a trailing
    // clause is a consequence nobody reads.
    render(<ActionCard risk="destructive" {...card} />);

    const rendered = screen
      .getAllByRole("definition")
      .map((node) => node.textContent ?? "")
      .join("|");

    expect(rendered).toBe(`${card.action}|${card.resource}|${card.consequence}|${card.cost}`);
  });

  it("is a labelled group, not four loose lines", () => {
    render(<ActionCard risk="action" {...card} />);

    expect(screen.getByRole("region", { name: card.action })).toBeTruthy();
  });

  it("omits cost when there is none rather than printing an empty row", () => {
    render(<ActionCard risk="action" action="a" resource="r" labels={labels} />);

    expect(screen.queryByText("Cost")).toBeNull();
  });
});

describe("the three risk tiers are distinguishable", () => {
  it("renders information as prose, with no card and no controls", () => {
    // If information were a card, every sentence would look like a decision and
    // the cards would stop being read at all.
    const { container } = render(
      <ActionCard
        risk="information"
        action="43 customers are inactive."
        resource=""
        labels={labels}
      />,
    );

    expect(container.querySelector(".k-action")).toBeNull();
    expect(container.querySelector(".k-action__prose")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders an action as a bordered card", () => {
    const { container } = render(<ActionCard risk="action" {...card} />);

    expect(container.querySelector(".k-action--action")).not.toBeNull();
    expect(container.querySelector(".k-action--destructive")).toBeNull();
  });

  it("renders a destructive action as an emphasised card stating the consequence", () => {
    const { container } = render(<ActionCard risk="destructive" {...card} />);

    expect(container.querySelector(".k-action--destructive")).not.toBeNull();
    expect(screen.getByText(card.consequence)).toBeTruthy();
  });

  it("gives each tier a distinct class, which is what the stylesheet keys on", () => {
    // The stylesheet renders these three differently — border weight, border
    // colour and background, not colour alone. jsdom applies no stylesheet, so
    // this pins the contract the CSS depends on; the visual difference itself
    // is asserted in the stylesheet test.
    const classes = (["information", "action", "destructive"] as const).map((risk) => {
      const { container } = render(
        <ActionCard risk={risk} action="a" resource="r" labels={labels} />,
      );
      return container.firstElementChild?.className ?? "";
    });

    expect(new Set(classes).size).toBe(3);
  });
});

describe("approval controls", () => {
  it("offers explicit approve and reject, never a lone yes", () => {
    render(
      <ApprovalCard
        risk="destructive"
        approvalId="apr_1"
        pending={false}
        onApprove={() => undefined}
        onReject={() => undefined}
        {...card}
      />,
    );

    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  });

  it("puts reject before approve in the DOM at the destructive tier", () => {
    // Tab order reaches the safe control first.
    render(
      <ApprovalCard
        risk="destructive"
        approvalId="apr_1"
        pending={false}
        onApprove={() => undefined}
        onReject={() => undefined}
        {...card}
      />,
    );

    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Reject", "Approve"]);
  });

  it("calls the handler the user actually chose", async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <ApprovalCard
        risk="action"
        approvalId="apr_1"
        pending={false}
        onApprove={onApprove}
        onReject={onReject}
        {...card}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Reject" }));

    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("disables both controls while a decision is in flight", async () => {
    // Otherwise an impatient double-click sends two decisions, and the second
    // one is answered with a 409 the user did not cause.
    const onApprove = vi.fn();
    render(
      <ApprovalCard
        risk="action"
        approvalId="apr_1"
        pending
        onApprove={onApprove}
        onReject={() => undefined}
        {...card}
      />,
    );

    const approve = screen.getByRole("button", { name: "Submitting…" });
    await userEvent.click(approve);

    expect(onApprove).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Reject" }).hasAttribute("disabled")).toBe(true);
  });
});
