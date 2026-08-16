import type { AddressInfo } from "node:net";
import { createRealtimeServer, type RealtimeDeps, resetRegistry, resetWaits } from "@keel/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeelClient } from "../src/index.js";

/**
 * Suspend and resume across the wire (doc 05 Part A, doc 01 §4.3).
 *
 * The approvals integration tests prove the *record* survives a restart. These
 * prove the other half: that a run actually stops, that an AG-UI `INTERRUPT`
 * reaches the browser, and that the decision travelling back through
 * `POST /rt/v1/approvals/{id}/decide` resumes exactly the run it belongs to.
 *
 * Everything here runs against a real HTTP server on a real socket. A mocked
 * transport would be asserting that the mock suspends.
 */

let server: ReturnType<typeof createRealtimeServer>["server"];
let endpoint: string;

async function listen(deps: RealtimeDeps): Promise<void> {
  const created = createRealtimeServer(deps);
  server = created.server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  endpoint = `http://127.0.0.1:${port}`;
}

const client = () => new KeelClient({ endpoint, projectId: "proj_1", identity: async () => null });

/**
 * A driver that asks for one approval and reports what it was told. The tool is
 * only "executed" on approval, which is the whole point: a run that streams the
 * result anyway has not suspended, it has merely announced itself.
 */
function approvalDrive(
  mode: "confirm" | "approve",
  outcome: { decision?: string; executed?: boolean },
  timeoutMs?: number,
): RealtimeDeps["drive"] {
  return async (run, _message, emitEvent, ctx) => {
    emitEvent({ type: "RUN_STARTED", run_id: run.run_id });

    const decision = await ctx.requestApproval({
      approvalId: "apr_01J000000000000000000000",
      tool: "cancelSubscription",
      mode,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    outcome.decision = decision;

    if (decision === "approved") {
      outcome.executed = true;
      emitEvent({ type: "TOOL_CALL_START", call_id: "c1", tool: "cancelSubscription" });
      emitEvent({ type: "TOOL_CALL_RESULT", call_id: "c1", ok: true });
      emitEvent({ type: "TOOL_CALL_END", call_id: "c1" });
    }

    emitEvent({
      type: "RUN_FINISHED",
      run_id: run.run_id,
      state: decision === "approved" ? "Completed" : "Cancelled",
    });
  };
}

/** Resolves with the approval id the moment the INTERRUPT arrives. */
function interruptFrom(c: KeelClient): Promise<string> {
  return new Promise<string>((resolve) => {
    c.on("INTERRUPT", (event) => resolve(event.approval_id));
  });
}

const decide = (sessionId: string, approvalId: string, body: unknown) =>
  fetch(`${endpoint}/rt/v1/approvals/${approvalId}/decide`, {
    method: "POST",
    headers: {
      "x-keel-session": sessionId,
      "content-type": "application/json",
      "idempotency-key": `test_${Math.random().toString(36).slice(2)}`,
    },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  resetRegistry();
  resetWaits();
});

afterEach(async () => {
  resetWaits();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("a run suspends on INTERRUPT and resumes on the decision", () => {
  it("does not execute the tool until the decision arrives", async () => {
    const outcome: { decision?: string; executed?: boolean } = {};
    await listen({ drive: approvalDrive("confirm", outcome) });

    const c = client();
    const interrupt = interruptFrom(c);
    const conversation = await c.createConversation();
    const run = c.run(conversation.id, "cancel my subscription");

    const approvalId = await interrupt;
    expect(approvalId).toBe("apr_01J000000000000000000000");

    // Suspended: the driver is parked inside requestApproval, so nothing has
    // run. If this were merely a notification, `executed` would already be true.
    expect(outcome.executed).toBeUndefined();

    const response = await decide(c.session?.id ?? "", approvalId, { decision: "approved" });
    await run;

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ decision: "approved", resumed: true });
    expect(outcome.decision).toBe("approved");
    expect(outcome.executed).toBe(true);
  });

  it("leaves the tool unexecuted when the user says no", async () => {
    const outcome: { decision?: string; executed?: boolean } = {};
    await listen({ drive: approvalDrive("confirm", outcome) });

    const c = client();
    const interrupt = interruptFrom(c);
    const conversation = await c.createConversation();
    const run = c.run(conversation.id, "cancel my subscription");

    await decide(c.session?.id ?? "", await interrupt, { decision: "rejected" });
    await run;

    expect(outcome.decision).toBe("rejected");
    expect(outcome.executed).toBeUndefined();
  });

  it("rejects a decision that is neither approved nor rejected", async () => {
    // "maybe" must not be read as consent by a truthiness check somewhere.
    const outcome: { decision?: string } = {};
    await listen({ drive: approvalDrive("confirm", outcome) });

    const c = client();
    const interrupt = interruptFrom(c);
    const conversation = await c.createConversation();
    const run = c.run(conversation.id, "go");

    const approvalId = await interrupt;
    const bad = await decide(c.session?.id ?? "", approvalId, { decision: "maybe" });
    expect(bad.status).toBe(400);
    expect(outcome.decision).toBeUndefined();

    await decide(c.session?.id ?? "", approvalId, { decision: "rejected" });
    await run;
  });
});

describe("who may decide", () => {
  it("refuses a decision from another session", async () => {
    const outcome: { decision?: string } = {};
    await listen({ drive: approvalDrive("confirm", outcome) });

    const owner = client();
    const stranger = client();
    const interrupt = interruptFrom(owner);
    const conversation = await owner.createConversation();
    const run = owner.run(conversation.id, "cancel");

    const approvalId = await interrupt;
    await stranger.ensureSession();

    const response = await decide(stranger.session?.id ?? "", approvalId, {
      decision: "approved",
    });

    // 404, not 403: a stranger must not learn that this approval exists.
    expect(response.status).toBe(404);
    expect(outcome.decision).toBeUndefined();

    await decide(owner.session?.id ?? "", approvalId, { decision: "rejected" });
    await run;
  });

  it("refuses to settle an approve-mode approval through the widget endpoint", async () => {
    // `approve` means a different principal, holding a role the requester does
    // not have. If this endpoint accepted it, the two controls would be one.
    const outcome: { decision?: string } = {};
    await listen({ drive: approvalDrive("approve", outcome, 200) });

    const c = client();
    const interrupt = interruptFrom(c);
    const conversation = await c.createConversation();
    const run = c.run(conversation.id, "refund everything");

    const response = await decide(c.session?.id ?? "", await interrupt, {
      decision: "approved",
    });

    expect(response.status).toBe(403);
    await run;
    expect(outcome.decision).toBe("expired");
  });

  it("attributes the decision to the session, not to the request body", async () => {
    const recorded: string[] = [];
    const outcome: { decision?: string } = {};
    await listen({
      drive: approvalDrive("confirm", outcome),
      recordDecision: async ({ decidedBy }) => {
        recorded.push(decidedBy);
        return { ok: true };
      },
    });

    const c = client();
    const interrupt = interruptFrom(c);
    const conversation = await c.createConversation();
    const run = c.run(conversation.id, "cancel");

    await decide(c.session?.id ?? "", await interrupt, {
      decision: "approved",
      decided_by: "usr_the_cfo",
    });
    await run;

    expect(recorded).toEqual([c.session?.id]);
  });
});

describe("the durable record comes first", () => {
  it("does not wake the run when the decision could not be persisted", async () => {
    // The run must act only on a decision that was written down. Waking it on a
    // failed write would resume on an answer nobody could later account for.
    const outcome: { decision?: string } = {};
    await listen({
      drive: approvalDrive("confirm", outcome, 300),
      recordDecision: async () => ({ ok: false }),
    });

    const c = client();
    const interrupt = interruptFrom(c);
    const conversation = await c.createConversation();
    const run = c.run(conversation.id, "cancel");

    const response = await decide(c.session?.id ?? "", await interrupt, {
      decision: "approved",
    });

    expect(response.status).toBe(409);
    await run;
    expect(outcome.decision).toBe("expired");
  });
});

describe("a suspended run cannot hang forever", () => {
  it("expires on its deadline rather than holding the connection open", async () => {
    const outcome: { decision?: string; executed?: boolean } = {};
    await listen({ drive: approvalDrive("confirm", outcome, 150) });

    const c = client();
    const conversation = await c.createConversation();
    await c.run(conversation.id, "cancel");

    expect(outcome.decision).toBe("expired");
    expect(outcome.executed).toBeUndefined();
  });

  it("releases the wait when the run is cancelled", async () => {
    // Otherwise a cancelled run sits in the map until its approval deadline,
    // holding a connection for a decision nobody will make.
    const outcome: { decision?: string } = {};
    await listen({ drive: approvalDrive("confirm", outcome, 60_000) });

    const c = client();
    let runId: string | null = null;
    c.on("CUSTOM", (e) => {
      if (e.name === "run.id") runId = (e.payload as { run_id: string }).run_id;
    });
    c.on("INTERRUPT", () => {
      if (runId !== null) void c.cancel(runId);
    });

    const conversation = await c.createConversation();
    await c.run(conversation.id, "cancel");

    // Cancelling closes the client's stream immediately, so the run promise can
    // resolve before the server-side driver has been woken. The property under
    // test is what the *server* does with the wait, so give it a tick.
    for (let i = 0; outcome.decision === undefined && i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(outcome.decision).toBe("cancelled");
  });
});

describe("an approval survives a page reload", () => {
  const IDENTITY = {
    issuer: "https://northwind.example",
    jwksUri: "https://northwind.example/.well-known/jwks.json",
    audience: "keel:proj_1",
    algorithms: ["EdDSA"] as const,
    allowSymmetric: false,
  };

  async function listenWithIdentity(drive: RealtimeDeps["drive"]) {
    const { generateIdentityKeypair, jwksFor, mintIdentityToken } = await import("@keel/identity");
    const keypair = await generateIdentityKeypair("k1");

    await listen({ drive, identity: IDENTITY, identityKeys: (await jwksFor(keypair)) as never });

    // A fresh token per call, which is what the page does after a reload.
    return (subject: string) => async () =>
      (
        await mintIdentityToken(keypair, {
          subject,
          issuer: IDENTITY.issuer,
          audience: IDENTITY.audience,
        })
      ).token;
  }

  it("re-raises the pending INTERRUPT to a new session for the same user", async () => {
    // The reload case. The browser goes away mid-approval and comes back with a
    // new session id; what makes it the same user is the identity subject, not
    // a token squirrelled away in storage.
    const outcome: { decision?: string; executed?: boolean } = {};
    const identityFor = await listenWithIdentity(approvalDrive("confirm", outcome, 30_000));

    const before = new KeelClient({
      endpoint,
      projectId: "proj_1",
      identity: identityFor("stf_arun"),
    });

    let runId = "";
    before.on("CUSTOM", (e) => {
      if (e.name === "run.id") runId = (e.payload as { run_id: string }).run_id;
    });
    const firstInterrupt = interruptFrom(before);
    const conversation = await before.createConversation();
    const firstRun = before.run(conversation.id, "cancel my subscription");

    await firstInterrupt;

    // The tab closes. Not a cancel: the user did not answer, they navigated.
    before.reset();
    await firstRun;

    const after = new KeelClient({
      endpoint,
      projectId: "proj_1",
      identity: identityFor("stf_arun"),
    });
    const restored = interruptFrom(after);
    const reattached = after.reattach(runId);

    expect(await restored).toBe("apr_01J000000000000000000000");
    // Still suspended, still unexecuted — the reload did not answer for anyone.
    expect(outcome.executed).toBeUndefined();

    await after.decide("apr_01J000000000000000000000", "approved");
    await reattached;

    expect(outcome.decision).toBe("approved");
    expect(outcome.executed).toBe(true);
  });

  it("refuses to reattach a run belonging to a different user", async () => {
    const outcome: { decision?: string } = {};
    const identityFor = await listenWithIdentity(approvalDrive("confirm", outcome, 1_000));

    const arun = new KeelClient({
      endpoint,
      projectId: "proj_1",
      identity: identityFor("stf_arun"),
    });
    let runId = "";
    arun.on("CUSTOM", (e) => {
      if (e.name === "run.id") runId = (e.payload as { run_id: string }).run_id;
    });
    const interrupt = interruptFrom(arun);
    const conversation = await arun.createConversation();
    const run = arun.run(conversation.id, "cancel");
    await interrupt;

    const priya = new KeelClient({
      endpoint,
      projectId: "proj_1",
      identity: identityFor("stf_priya"),
    });

    await expect(priya.reattach(runId)).rejects.toThrow();

    arun.reset();
    await run;
  });

  it("refuses to reattach an anonymous run from a new session", async () => {
    // An anonymous visitor has nothing to prove they are the same visitor, so
    // honouring this would hand a run's transcript to whoever guessed its id.
    const outcome: { decision?: string } = {};
    await listen({ drive: approvalDrive("confirm", outcome, 1_000) });

    const first = client();
    let runId = "";
    first.on("CUSTOM", (e) => {
      if (e.name === "run.id") runId = (e.payload as { run_id: string }).run_id;
    });
    const interrupt = interruptFrom(first);
    const conversation = await first.createConversation();
    const run = first.run(conversation.id, "cancel");
    await interrupt;

    const second = client();
    await expect(second.reattach(runId)).rejects.toThrow();

    first.reset();
    await run;
  });
});
