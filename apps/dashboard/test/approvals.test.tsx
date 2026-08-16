import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { canDecide, type PendingApproval } from "../src/features/approvals/types.ts";
import { ApprovalsView } from "../src/routes/Approvals.tsx";

/**
 * The approve-mode queue (doc 05 §E5, doc 03 §C4).
 *
 * The property that matters is separation of duties: this screen exists so a
 * *second* person decides, and every test below is really asking whether it can
 * be talked into letting the first one do it instead.
 */

const base: PendingApproval = {
  id: "apr_1",
  run_id: "run_1",
  tool: "issueRefund",
  risk: "critical",
  mode: "approve",
  state: "pending",
  requested_by: "usr_arun",
  decide_by_role: "finance_approver",
  requested_at: "2026-08-13T09:00:00.000Z",
  expires_at: "2026-08-13T09:30:00.000Z",
  args: { amount: 4200 },
  action: "Issue a refund of £4,200",
  resource: "inv_7781 · Northwind Traders",
  consequence: "The payment is returned and the invoice cannot be reissued.",
  cost: "£4,200.00",
};

const approver = { id: "usr_priya", roles: ["finance_approver"] };
const NOW = new Date("2026-08-13T09:05:00.000Z");

const view = (approvals: readonly PendingApproval[], operator = approver, onDecide = vi.fn()) => {
  render(
    <MemoryRouter>
      <ApprovalsView approvals={approvals} operator={operator} now={NOW} onDecide={onDecide} />
    </MemoryRouter>,
  );
  return onDecide;
};

describe("who is offered the controls", () => {
  it("offers them to a different principal holding the role", () => {
    view([base]);

    expect(screen.getByRole("button", { name: "Approve" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDefined();
  });

  it("refuses the requester their own approval, and says why", () => {
    // The whole reason approve mode exists. If this screen let Arun approve
    // Arun's refund, the two controls would be one.
    view([base], { id: "usr_arun", roles: ["finance_approver"] });

    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByText("You requested this. Someone else has to approve it.")).toBeDefined();
  });

  it("refuses an operator without the role", () => {
    view([base], { id: "usr_sam", roles: ["support"] });

    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByText("Requires the finance_approver role.")).toBeDefined();
  });

  it("refuses an approval that has already lapsed", () => {
    view([{ ...base, expires_at: "2026-08-13T09:01:00.000Z" }]);

    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByText("Expired.")).toBeDefined();
  });

  it("refuses one that was already decided", () => {
    view([{ ...base, state: "approved" }]);

    expect(screen.getByText("Already approved.")).toBeDefined();
  });
});

describe("what the approver is shown", () => {
  it("states the same four facts, in the same order, as the widget card", () => {
    // The approver and the requester must be looking at the same thing, or
    // "I approved it" and "I asked for it" stop referring to the same action.
    view([base]);

    const card = screen.getByRole("region", { name: base.action });
    const facts = within(card)
      .getAllByRole("definition")
      .map((n) => n.textContent);

    expect(facts).toEqual([base.action, base.resource, base.consequence, base.cost]);
  });

  it("renders a critical approval as the emphasised tier", () => {
    view([base]);

    expect(screen.getByRole("region", { name: base.action }).className).toContain(
      "k-action--destructive",
    );
  });

  it("links to the run so the decision can be made in context", () => {
    view([base]);

    expect(screen.getByRole("link", { name: "run_1" }).getAttribute("href")).toBe(
      "/activity/runs/run_1",
    );
  });
});

describe("the queue", () => {
  it("puts the longest-waiting approval first", () => {
    const older = { ...base, id: "apr_0", requested_at: "2026-08-13T08:00:00.000Z" };
    view([base, older]);

    const ids = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
    expect(ids.length).toBe(2);
    expect(screen.getAllByRole("listitem")[0]?.textContent).toContain("issueRefund");
  });

  it("says nothing is waiting rather than rendering an empty list", () => {
    view([]);

    expect(screen.getByText("Nothing waiting")).toBeDefined();
  });

  it("passes the operator's actual choice to the caller", async () => {
    const onDecide = view([base], approver, vi.fn());

    await userEvent.click(screen.getByRole("button", { name: "Reject" }));

    expect(onDecide).toHaveBeenCalledWith("apr_1", "rejected");
  });
});

describe("canDecide is the rule, not the rendering", () => {
  it("never permits confirm-mode approvals here", () => {
    // Confirmations belong to the person who asked, in the widget. Letting an
    // operator settle one from the dashboard would answer for a user who never
    // saw the question.
    expect(canDecide({ ...base, mode: "confirm" }, approver)).toBe(false);
  });

  it("requires both the role and a different person", () => {
    expect(canDecide(base, approver)).toBe(true);
    expect(canDecide(base, { id: "usr_arun", roles: ["finance_approver"] })).toBe(false);
    expect(canDecide(base, { id: "usr_priya", roles: [] })).toBe(false);
  });
});
