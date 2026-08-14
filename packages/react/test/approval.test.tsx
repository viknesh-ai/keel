import type { AddressInfo } from "node:net";
import { createRealtimeServer, type RealtimeDeps, resetRegistry, resetWaits } from "@keel/api";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assistant } from "../src/assistant.js";
import { KeelProvider } from "../src/provider.js";

/**
 * The approval flow end to end, against a real server (doc 05 §E6, doc 03 §C4).
 *
 * The exit criterion for this session is a reload restoring the card, and a
 * reload is not something a mocked client can be made to simulate honestly:
 * what is being tested is that the *server* replays enough for the widget to
 * rebuild its state. So these run against a real HTTP server and a real SSE
 * stream, with the React tree unmounted and remounted to stand in for the page
 * going away.
 */

let server: ReturnType<typeof createRealtimeServer>["server"];
let endpoint: string;

const IDENTITY = {
  issuer: "https://northwind.example",
  jwksUri: "https://northwind.example/.well-known/jwks.json",
  audience: "keel:proj_1",
  algorithms: ["EdDSA"] as const,
  allowSymmetric: false,
};

/** Asks for one approval, then reports whether the tool ran. */
function approvalDrive(
  mode: "confirm" | "approve",
  outcome: { decision?: string; executed?: boolean },
): RealtimeDeps["drive"] {
  return async (run, _message, emitEvent, ctx) => {
    emitEvent({ type: "RUN_STARTED", run_id: run.run_id });

    const decision = await ctx.requestApproval({
      approvalId: "apr_1",
      tool: "cancelSubscription",
      mode,
      risk: "critical",
      action: "Cancel the subscription",
      resource: "acct_8891 · Northwind Traders",
      consequence: "Billing stops immediately and the plan cannot be restored at this price.",
      cost: "£0.00",
      timeoutMs: 30_000,
    });

    outcome.decision = decision;
    if (decision === "approved") outcome.executed = true;

    emitEvent({
      type: "RUN_FINISHED",
      run_id: run.run_id,
      state: decision === "approved" ? "Completed" : "Cancelled",
    });
  };
}

/** Mints a fresh identity token per call, exactly as the host page would. */
async function listen(drive: RealtimeDeps["drive"]) {
  const { generateIdentityKeypair, jwksFor, mintIdentityToken } = await import("@keel/identity");
  const keypair = await generateIdentityKeypair("k1");

  const created = createRealtimeServer({
    drive,
    identity: IDENTITY,
    identityKeys: (await jwksFor(keypair)) as never,
  });
  server = created.server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return async () =>
    (
      await mintIdentityToken(keypair, {
        subject: "stf_arun",
        issuer: IDENTITY.issuer,
        audience: IDENTITY.audience,
      })
    ).token;
}

function renderWidget(identity: () => Promise<string | null>) {
  return render(
    <KeelProvider endpoint={endpoint} projectId="proj_1" identity={identity}>
      <Assistant />
    </KeelProvider>,
  );
}

// Real crypto, a real socket and a real SSE stream: slower than a mock, and
// worth it, because a mock cannot demonstrate that a reload restores anything.
const WAIT = { timeout: 10_000 };

const findCard = () => screen.findByRole("region", { name: "Cancel the subscription" }, WAIT);

async function ask(text: string): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: "Open assistant" }));
  await userEvent.type(screen.getByLabelText("Your question"), text);
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
}

beforeEach(() => {
  resetRegistry();
  resetWaits();
  sessionStorage.clear();
});

afterEach(async () => {
  resetWaits();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the widget renders an interrupt as a decision, not a sentence", () => {
  it("shows the four facts and explicit approve and reject controls", async () => {
    const outcome: { decision?: string; executed?: boolean } = {};
    const identity = await listen(approvalDrive("confirm", outcome));
    renderWidget(identity);

    await ask("cancel my subscription");

    const card = await findCard();
    expect(card.className).toContain("k-action--destructive");
    expect(card.textContent).toContain("acct_8891 · Northwind Traders");
    expect(card.textContent).toContain("Billing stops immediately");
    expect(card.textContent).toContain("£0.00");

    expect(screen.getByRole("button", { name: "Approve" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDefined();

    // Nothing has happened yet. The run is parked.
    expect(outcome.executed).toBeUndefined();
  }, 20_000);

  it("sends the decision and lets the run finish", async () => {
    const outcome: { decision?: string; executed?: boolean } = {};
    const identity = await listen(approvalDrive("confirm", outcome));
    renderWidget(identity);

    await ask("cancel my subscription");
    await findCard();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(outcome.decision).toBe("approved"), WAIT);
    expect(outcome.executed).toBe(true);

    // The card goes when the server confirms, not when the user clicks.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve" })).toBeNull(), WAIT);
  }, 20_000);

  it("offers no buttons when someone else must approve", async () => {
    // `approve` mode is a different principal's decision. Showing this user two
    // controls that would be refused is a lie about who is in control.
    const outcome: { decision?: string } = {};
    const identity = await listen(approvalDrive("approve", outcome));
    renderWidget(identity);

    await ask("refund everything");

    expect(await screen.findByText("Waiting for an approver.", {}, WAIT)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  }, 20_000);
});

describe("the approval survives a reload", () => {
  it("restores the card in a freshly mounted widget", async () => {
    const outcome: { decision?: string; executed?: boolean } = {};
    const identity = await listen(approvalDrive("confirm", outcome));

    const first = renderWidget(identity);
    await ask("cancel my subscription");
    await findCard();

    // The page goes away mid-approval. Not a cancel: the user navigated, they
    // did not answer.
    first.unmount();

    renderWidget(identity);
    await userEvent.click(screen.getByRole("button", { name: "Open assistant" }));

    const restored = await findCard();
    expect(restored.textContent).toContain("Billing stops immediately");
    expect(outcome.executed).toBeUndefined();

    // And it is a live card, not a picture of one.
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(outcome.decision).toBe("approved"), WAIT);
  }, 20_000);
});

describe("accessibility", () => {
  it("has zero axe-core violations with an approval on screen", async () => {
    // A decision the user cannot read or reach by keyboard is not a control.
    const outcome: { decision?: string } = {};
    const identity = await listen(approvalDrive("confirm", outcome));
    renderWidget(identity);

    await ask("cancel my subscription");
    await findCard();

    const results = await axe.run(document.body, {
      runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
    });

    expect(results.violations.map((v) => v.id)).toEqual([]);
  }, 20_000);
});
