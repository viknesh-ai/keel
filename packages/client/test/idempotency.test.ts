import type { AddressInfo } from "node:net";
import { createRealtimeServer, type RealtimeDeps, resetRegistry, resetWaits } from "@keel/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeelClient } from "../src/index.js";

/**
 * `Idempotency-Key` on the mutating endpoint (doc 02 §1, doc 05 Part A).
 *
 * Required rather than optional, because an optional header is one clients omit
 * and nobody notices until a double-click has recorded two decisions. The gate
 * stores the *response*, so a repeat replays the original answer instead of
 * executing again — a duplicate-rejection alone would leave the caller unable
 * to tell whether their first attempt landed.
 */

let server: ReturnType<typeof createRealtimeServer>["server"];
let endpoint: string;

/** Counts how many times a decision actually reached the durable record. */
const recorded: string[] = [];

async function listen(): Promise<{ approvalId: string; sessionId: string }> {
  const drive: RealtimeDeps["drive"] = async (run, _message, emitEvent, ctx) => {
    emitEvent({ type: "RUN_STARTED", run_id: run.run_id });
    const decision = await ctx.requestApproval({
      approvalId: "apr_gate",
      tool: "cancelSubscription",
      mode: "confirm",
      timeoutMs: 20_000,
    });
    emitEvent({ type: "RUN_FINISHED", run_id: run.run_id, state: String(decision) });
  };

  const created = createRealtimeServer({
    drive,
    recordDecision: async ({ decision }) => {
      recorded.push(decision);
      return { ok: true };
    },
  });
  server = created.server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const client = new KeelClient({ endpoint, projectId: "p", identity: async () => null });
  const interrupt = new Promise<string>((resolve) => {
    client.on("INTERRUPT", (e) => resolve(e.approval_id));
  });
  const conversation = await client.createConversation();
  void client.run(conversation.id, "cancel");

  return { approvalId: await interrupt, sessionId: client.session?.id ?? "" };
}

const decide = (sessionId: string, approvalId: string, key: string | null) =>
  fetch(`${endpoint}/rt/v1/approvals/${approvalId}/decide`, {
    method: "POST",
    headers: {
      "x-keel-session": sessionId,
      "content-type": "application/json",
      ...(key === null ? {} : { "idempotency-key": key }),
    },
    body: JSON.stringify({ decision: "approved" }),
  });

beforeEach(() => {
  resetRegistry();
  resetWaits();
  recorded.length = 0;
});

afterEach(async () => {
  resetWaits();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the header is required", () => {
  it("refuses a decision with no Idempotency-Key", async () => {
    const { approvalId, sessionId } = await listen();

    const response = await decide(sessionId, approvalId, null);

    expect(response.status).toBe(400);
    expect(recorded).toEqual([]);
  });

  it("refuses an empty one rather than treating it as absent-but-fine", async () => {
    const { approvalId, sessionId } = await listen();

    expect((await decide(sessionId, approvalId, "   ")).status).toBe(400);
  });

  it("refuses an absurdly long one", async () => {
    const { approvalId, sessionId } = await listen();

    expect((await decide(sessionId, approvalId, "x".repeat(300))).status).toBe(400);
  });
});

describe("a repeat replays rather than re-executing", () => {
  it("records the decision once and returns the original response", async () => {
    const { approvalId, sessionId } = await listen();

    const first = await decide(sessionId, approvalId, "key-1");
    const second = await decide(sessionId, approvalId, "key-1");

    expect(recorded).toEqual(["approved"]);
    expect(second.status).toBe(first.status);
    expect(await second.text()).toBe(await first.text());
    // A caller can tell a replay from a fresh execution without diffing bodies
    // that are identical by design.
    expect(second.headers.get("idempotent-replay")).toBe("true");
  });

  it("replays a refusal too, so a client cannot retry past a decision", async () => {
    // The interesting half. If only successes were remembered, a 403 could be
    // re-attempted until something changed underneath it.
    const { approvalId, sessionId } = await listen();

    const first = await fetch(`${endpoint}/rt/v1/approvals/${approvalId}/decide`, {
      method: "POST",
      headers: {
        "x-keel-session": sessionId,
        "content-type": "application/json",
        "idempotency-key": "key-bad",
      },
      body: JSON.stringify({ decision: "maybe" }),
    });
    expect(first.status).toBe(400);

    const second = await decide(sessionId, approvalId, "key-bad");

    expect(second.status).toBe(400);
    expect(second.headers.get("idempotent-replay")).toBe("true");
    expect(recorded).toEqual([]);
  });

  it("treats a different key as a different request", async () => {
    const { approvalId, sessionId } = await listen();

    await decide(sessionId, approvalId, "key-1");
    const second = await decide(sessionId, approvalId, "key-2");

    // Refused on its merits — the approval is settled and the run has moved on —
    // rather than being replayed. The gate does not answer questions it was not
    // asked, which is why a fresh key gets a fresh, honest 404.
    expect(second.headers.get("idempotent-replay")).toBeNull();
    expect(second.status).toBe(404);
  });
});
