import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { agentsRepo, createPool, type OrgScope, runsRepo, withOrgScope } from "@keel/api";
import type { ToolContract } from "@keel/contracts";
import { executeTool, httpCall } from "@keel/tool-runtime";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionTestDatabase, type TestDatabase } from "./helpers/database.js";
import { type SeededOrg, seedOrg } from "./helpers/seed.js";

/**
 * Cancellation, end to end (doc 01 §4.1–4.2, session 2.5).
 *
 * The exit criterion: start a run with a slow tool, cancel it, and assert the
 * outbound HTTP request was **actually aborted server-side** — not merely that
 * a stream closed. So there is a real downstream server here that records what
 * Node told it, and a real database recording what the run became.
 *
 * The second half matters as much as the first: a cancelled run keeps its
 * partial trace. "How far did it get before I stopped it?" is the first
 * question anyone asks, and it is unanswerable if cancelling tidies up.
 */

let db: TestDatabase;
let pool: Pool;
let org: SeededOrg;
let agentVersionId: string;

let downstream: Server;
let url: string;
const observed = { received: 0, aborted: 0, completed: 0 };

const inOrg = <T>(fn: (scope: OrgScope) => Promise<T>): Promise<T> =>
  withOrgScope(pool, org.orgId, fn);

const slowTool: ToolContract = {
  name: "cancel_subscription",
  version: 1,
  title: "Cancel a subscription",
  description: "Ends billing for an account.",
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
} as ToolContract;

beforeAll(async () => {
  db = await provisionTestDatabase("cancellation");
  pool = createPool(db.appUrl);

  const seeder = await db.connectAsApp();
  try {
    org = await seedOrg(seeder, { slug: "alpha", email: "owner@alpha.example" });
  } finally {
    await seeder.end();
  }

  agentVersionId = await inOrg(async (scope) => {
    const agent = await agentsRepo.createAgent(scope, {
      projectId: org.projectId,
      name: "Support",
      slug: "support",
    });
    const version = await agentsRepo.publishAgentVersion(scope, {
      agentId: agent.id,
      instructions: "help",
    });
    return version.id;
  });

  // A downstream that never answers in time, so the only way the request ends
  // is the client giving up on it.
  downstream = createServer((req, res) => {
    observed.received += 1;
    const timer = setTimeout(() => {
      observed.completed += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    }, 30_000);
    req.on("aborted", () => {
      observed.aborted += 1;
      clearTimeout(timer);
    });
    res.on("close", () => clearTimeout(timer));
  });
  await new Promise<void>((resolve) => downstream.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(downstream.address() as AddressInfo).port}/subscriptions/cancel`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => downstream.close(() => resolve()));
  await pool?.end();
  await db?.drop();
});

async function newRun(): Promise<string> {
  return inOrg(async (scope) => {
    const run = await runsRepo.createRun(scope, {
      projectId: org.projectId,
      environmentId: org.environmentId,
      agentVersionId,
      trigger: "chat",
    });
    return run.id;
  });
}

describe("cancelling a run with a slow tool in flight", () => {
  it("aborts the outbound HTTP request server-side and records Cancelled", async () => {
    observed.received = 0;
    observed.aborted = 0;
    observed.completed = 0;

    const runId = await newRun();
    const controller = new AbortController();

    await inOrg(async (scope) => {
      await runsRepo.transitionRun(scope, runId, "Executing");
      await runsRepo.appendStep(scope, {
        runId,
        type: "tool",
        status: "pending",
        integrity: "system",
        payload: { tool: "cancel_subscription" },
      });
    });

    const execution = executeTool({
      tool: slowTool,
      args: { account_id: "acct_8891" },
      signal: controller.signal,
      sleep: async () => undefined,
      invoke: async (args, ctx) =>
        httpCall({
          url,
          method: "POST",
          headers: {},
          body: args,
          signal: ctx.signal,
          tool: slowTool.name,
          idempotencyKey: ctx.idempotencyKey,
        }),
    });

    // The user presses Stop, but only once the request is genuinely in flight —
    // cancelling before it lands would prove nothing.
    while (observed.received === 0) await new Promise((r) => setTimeout(r, 5));
    controller.abort();

    const result = await execution;
    const cancelled = await inOrg((scope) =>
      runsRepo.cancelRun(scope, runId, "the user stopped the run"),
    );

    expect(result.status).toBe("cancelled");

    // The assertion the session exists for: the *downstream* observed its
    // client go away, and never finished the work.
    for (let i = 0; observed.aborted === 0 && i < 200; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(observed.aborted).toBe(1);
    expect(observed.completed).toBe(0);

    expect(cancelled?.state).toBe("Cancelled");
    expect(cancelled?.ended_at).not.toBeNull();
  }, 30_000);

  it("keeps the partial trace, because that is what the question is about", async () => {
    const runId = await newRun();

    await inOrg(async (scope) => {
      await runsRepo.transitionRun(scope, runId, "Executing");
      for (const type of ["context", "retrieval", "tool"] as const) {
        await runsRepo.appendStep(scope, {
          runId,
          type,
          status: "ok",
          integrity: "system",
          payload: { note: type },
        });
      }
    });

    await inOrg((scope) => runsRepo.cancelRun(scope, runId));

    const steps = await inOrg((scope) => runsRepo.listSteps(scope, runId));

    expect(steps.map((s) => s.type)).toEqual(["context", "retrieval", "tool"]);
  });

  it("refuses to cancel a run that already finished", async () => {
    // Otherwise a late Stop rewrites history to say the user stopped something
    // that had in fact completed.
    const runId = await newRun();
    await inOrg((scope) => runsRepo.endRun(scope, runId, { state: "Completed" }));

    const cancelled = await inOrg((scope) => runsRepo.cancelRun(scope, runId));
    const run = await inOrg((scope) => runsRepo.getRun(scope, runId));

    expect(cancelled).toBeUndefined();
    expect(run?.state).toBe("Completed");
  });

  it("is idempotent: cancelling twice does not move the timestamp", async () => {
    const runId = await newRun();

    const first = await inOrg((scope) => runsRepo.cancelRun(scope, runId));
    const second = await inOrg((scope) => runsRepo.cancelRun(scope, runId));
    const run = await inOrg((scope) => runsRepo.getRun(scope, runId));

    expect(first?.state).toBe("Cancelled");
    expect(second).toBeUndefined();
    expect(run?.ended_at).toEqual(first?.ended_at);
  });
});
