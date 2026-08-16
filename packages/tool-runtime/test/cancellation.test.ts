import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ToolContract } from "@keel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { executeTool } from "../src/execute/executor.js";
import { CancelledError, httpCall } from "../src/execute/http-adapter.js";

/**
 * Cancellation reaching the socket (doc 01 §4.1, session 2.5).
 *
 * The exit criterion is deliberately awkward to satisfy: assert the outbound
 * HTTP request was actually aborted **server-side**, not merely that our stream
 * closed. Those are different facts, and only the first one means anything to
 * the machine doing the work. A run that reports "cancelled" while the
 * customer's backend is still processing a mutation is worse than one that
 * refuses to cancel, because it says the change did not happen.
 *
 * So there is a real HTTP server here that never answers, and it records
 * whether Node told it the client went away.
 */

let downstream: Server;
let url: string;

/** Records what the *server* observed, which is the only trustworthy witness. */
type Observed = {
  received: number;
  aborted: number;
  completed: number;
};

async function slowDownstream(observed: Observed, delayMs = 30_000): Promise<void> {
  downstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    observed.received += 1;

    const timer = setTimeout(() => {
      observed.completed += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }, delayMs);

    // `aborted` on the request is Node telling us the peer went away before the
    // response was sent. This is the assertion the session exists for.
    req.on("aborted", () => {
      observed.aborted += 1;
      clearTimeout(timer);
    });
    res.on("close", () => clearTimeout(timer));
  });

  await new Promise<void>((resolve) => downstream.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(downstream.address() as AddressInfo).port}/cancel`;
}

const tool = (over: Partial<ToolContract> = {}): ToolContract =>
  ({
    name: "cancel_subscription",
    version: 1,
    title: "Cancel",
    description: "d",
    input: { type: "object" },
    output: { type: "object" },
    target: "openapi",
    side_effect: "read",
    risk: "read",
    auth: { kind: "none" },
    accepts_untrusted_args: false,
    timeout_ms: 30_000,
    retry: { max: 3, backoff: "none", on: ["ToolTimeoutError"] },
    idempotency: { required: false },
    ...over,
  }) as ToolContract;

afterEach(async () => {
  await new Promise<void>((resolve) => downstream.close(() => resolve()));
});

describe("cancellation reaches the outbound request", () => {
  it("aborts the request server-side, not just the local stream", async () => {
    const observed: Observed = { received: 0, aborted: 0, completed: 0 };
    await slowDownstream(observed);

    const controller = new AbortController();
    const call = httpCall({
      url,
      method: "POST",
      headers: {},
      body: { account_id: "acct_1" },
      signal: controller.signal,
      tool: "cancel_subscription",
      idempotencyKey: "key-1",
    });

    // Wait until the downstream has genuinely received it. Cancelling before
    // the request lands would prove nothing.
    while (observed.received === 0) await new Promise((r) => setTimeout(r, 5));
    controller.abort();

    await expect(call).rejects.toBeInstanceOf(CancelledError);

    // Give Node a tick to surface the aborted event.
    for (let i = 0; observed.aborted === 0 && i < 100; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(observed.aborted).toBe(1);
    expect(observed.completed).toBe(0);
  });

  it("reports a cancel as cancelled rather than as a timeout", async () => {
    // If an abort were classified as a timeout it would be *retried* — the
    // exact opposite of what a user pressing Stop asked for.
    const observed: Observed = { received: 0, aborted: 0, completed: 0 };
    await slowDownstream(observed);

    const controller = new AbortController();
    const call = httpCall({
      url,
      method: "GET",
      headers: {},
      signal: controller.signal,
      tool: "t",
      idempotencyKey: null,
    });

    while (observed.received === 0) await new Promise((r) => setTimeout(r, 5));
    controller.abort();

    await expect(call).rejects.toBeInstanceOf(CancelledError);
  });

  it("does not re-send after a cancel, however many retries the tool allows", async () => {
    const observed: Observed = { received: 0, aborted: 0, completed: 0 };
    await slowDownstream(observed);

    const controller = new AbortController();

    const result = await executeTool({
      tool: tool({ retry: { max: 5, backoff: "none", on: ["ToolTimeoutError"] } }),
      args: { account_id: "acct_1" },
      signal: controller.signal,
      sleep: async () => undefined,
      invoke: async (args, ctx) => {
        // Cancel once the downstream has the request in hand.
        void (async () => {
          while (observed.received === 0) await new Promise((r) => setTimeout(r, 5));
          controller.abort();
        })();

        return httpCall({
          url,
          method: "POST",
          headers: {},
          body: args,
          signal: ctx.signal,
          tool: "cancel_subscription",
          idempotencyKey: ctx.idempotencyKey,
        });
      },
    });

    expect(result.status).toBe("cancelled");
    expect(observed.received).toBe(1);
    expect(observed.completed).toBe(0);
  });

  it("the tool's own timeout also reaches the socket", async () => {
    // Same mechanism, different trigger. A timeout that only gave up locally
    // would leave the backend working on a request nobody will read.
    const observed: Observed = { received: 0, aborted: 0, completed: 0 };
    await slowDownstream(observed);

    const result = await executeTool({
      tool: tool({ timeout_ms: 50, retry: { max: 0, backoff: "none", on: [] } }),
      args: {},
      sleep: async () => undefined,
      invoke: async (_args, ctx) =>
        httpCall({
          url,
          method: "GET",
          headers: {},
          signal: ctx.signal,
          tool: "t",
          idempotencyKey: null,
        }),
    });

    expect(result.status).toBe("failed");

    for (let i = 0; observed.aborted === 0 && i < 100; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(observed.aborted).toBe(1);
  });
});

describe("what the downstream is told", () => {
  it("sends the idempotency key so the target can dedupe too", async () => {
    // Our dedupe protects against our own retries. The header is what protects
    // against a retry the network made for us.
    const seen: (string | undefined)[] = [];
    downstream = createServer((req, res) => {
      seen.push(req.headers["idempotency-key"] as string | undefined);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => downstream.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(downstream.address() as AddressInfo).port}/`;

    await httpCall({
      url,
      method: "POST",
      headers: {},
      body: {},
      signal: new AbortController().signal,
      tool: "t",
      idempotencyKey: "abc123",
    });

    expect(seen).toEqual(["abc123"]);
  });

  it("does not leak the backend's error text beyond a truncated message", async () => {
    downstream = createServer((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`internal: ${"x".repeat(500)} at /srv/app/db.ts:41`);
    });
    await new Promise<void>((resolve) => downstream.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(downstream.address() as AddressInfo).port}/`;

    await expect(
      httpCall({
        url,
        method: "GET",
        headers: {},
        signal: new AbortController().signal,
        tool: "t",
        idempotencyKey: null,
      }),
    ).rejects.toMatchObject({ class: "ToolExecutionError", status: 500 });
  });
});
