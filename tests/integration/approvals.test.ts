import { isTerminal, replay, transition } from "@keel/agent-runtime";
import {
  agentsRepo,
  approvalsRepo,
  createPool,
  type OrgScope,
  runsRepo,
  withOrgScope,
} from "@keel/api";
import { hashArguments } from "@keel/identity";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionTestDatabase, type TestDatabase } from "./helpers/database.js";
import { type SeededOrg, seedOrg } from "./helpers/seed.js";

/**
 * Approvals and durable suspend (doc 03 §C4, doc 01 §4.3).
 *
 * The exit criterion is the restart: an approval decided after the API process
 * has gone away must still resume the run. So the tests below deliberately
 * *destroy the pool* between requesting and deciding — nothing in memory
 * survives that, and if the design leaned on an in-process hold it would fail
 * here rather than in production six weeks later.
 */

let db: TestDatabase;
let pool: Pool;
let org: SeededOrg;
let agentVersionId: string;

const inOrg = <T>(fn: (scope: OrgScope) => Promise<T>): Promise<T> =>
  withOrgScope(pool, org.orgId, fn);

/** Simulates a restart: the pool is the process's entire in-memory state. */
async function restartProcess(): Promise<void> {
  await pool.end();
  pool = createPool(db.appUrl);
}

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

const ARGS = { customer_id: "cus_1", when: "immediately" };

async function request(
  runId: string,
  over: Partial<Parameters<typeof approvalsRepo.requestApproval>[1]> = {},
) {
  return inOrg((scope) =>
    approvalsRepo.requestApproval(scope, {
      runId,
      toolVersionId: "tv_1",
      tool: "cancelSubscription",
      args: ARGS,
      argsSha256: hashArguments(ARGS),
      risk: "critical",
      mode: "confirm",
      ...over,
    }),
  );
}

beforeAll(async () => {
  db = await provisionTestDatabase("approvals");
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
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

describe("the run suspends durably", () => {
  it("survives a process restart and resumes on approval", async () => {
    const runId = await newRun();
    const approval = await request(runId);

    await inOrg((scope) => runsRepo.transitionRun(scope, runId, "AwaitingApproval"));
    expect(approval.state).toBe("pending");

    // Everything in memory is gone.
    await restartProcess();

    const decided = await inOrg((scope) =>
      approvalsRepo.decideApproval(scope, {
        approvalId: approval.id,
        decision: "approved",
        decidedBy: "usr_manager",
      }),
    );

    expect(decided.ok).toBe(true);

    const resumed = await inOrg(async (scope) => {
      const consumed = await approvalsRepo.consumeApproval(scope, {
        approvalId: approval.id,
        argsSha256: hashArguments(ARGS),
      });
      expect(consumed.ok).toBe(true);
      return runsRepo.transitionRun(scope, runId, "Executing");
    });

    expect(resumed?.state).toBe("Executing");
  });

  it("still shows the approval as pending after a restart", async () => {
    const runId = await newRun();
    const approval = await request(runId);

    await restartProcess();

    const pending = await inOrg((scope) => approvalsRepo.listPending(scope, runId));
    expect(pending.map((a) => a.id)).toEqual([approval.id]);
  });
});

describe("an approved call cannot run with different arguments", () => {
  it("refuses consumption when the arguments changed", async () => {
    // The whole point of args_sha256: the approver saw one set of arguments and
    // authorised those. Anything else is a different action.
    const runId = await newRun();
    const approval = await request(runId);

    await inOrg((scope) =>
      approvalsRepo.decideApproval(scope, {
        approvalId: approval.id,
        decision: "approved",
        decidedBy: "usr_manager",
      }),
    );

    const consumed = await inOrg((scope) =>
      approvalsRepo.consumeApproval(scope, {
        approvalId: approval.id,
        argsSha256: hashArguments({ customer_id: "cus_2", when: "immediately" }),
      }),
    );

    expect(consumed.ok).toBe(false);
    if (consumed.ok) return;
    expect(consumed.reason).toBe("arguments_changed");
  });

  it("is not fooled by key reordering, which is the same action", () => {
    expect(hashArguments({ a: 1, b: 2 })).toBe(hashArguments({ b: 2, a: 1 }));
  });
});

describe("single use", () => {
  it("consumes an approval exactly once", async () => {
    const runId = await newRun();
    const approval = await request(runId);

    await inOrg((scope) =>
      approvalsRepo.decideApproval(scope, {
        approvalId: approval.id,
        decision: "approved",
        decidedBy: "usr_manager",
      }),
    );

    const first = await inOrg((scope) =>
      approvalsRepo.consumeApproval(scope, {
        approvalId: approval.id,
        argsSha256: hashArguments(ARGS),
      }),
    );
    const second = await inOrg((scope) =>
      approvalsRepo.consumeApproval(scope, {
        approvalId: approval.id,
        argsSha256: hashArguments(ARGS),
      }),
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe("already_consumed");
  });

  it("refuses to consume an approval that was never approved", async () => {
    const runId = await newRun();
    const approval = await request(runId);

    const consumed = await inOrg((scope) =>
      approvalsRepo.consumeApproval(scope, {
        approvalId: approval.id,
        argsSha256: hashArguments(ARGS),
      }),
    );

    expect(consumed.ok).toBe(false);
    if (consumed.ok) return;
    expect(consumed.reason).toBe("not_approved");
  });

  it("cannot be decided twice", async () => {
    const runId = await newRun();
    const approval = await request(runId);

    await inOrg((scope) =>
      approvalsRepo.decideApproval(scope, {
        approvalId: approval.id,
        decision: "approved",
        decidedBy: "usr_a",
      }),
    );
    const again = await inOrg((scope) =>
      approvalsRepo.decideApproval(scope, {
        approvalId: approval.id,
        decision: "rejected",
        decidedBy: "usr_b",
      }),
    );

    expect(again.ok).toBe(false);
  });
});

describe("confirm and approve are different controls", () => {
  it("lets the asking user confirm in confirm mode", async () => {
    const runId = await newRun();
    const approval = await request(runId, { mode: "confirm", requestedBy: "usr_arun" });

    const decided = await inOrg((scope) =>
      approvalsRepo.decideApproval(scope, {
        approvalId: approval.id,
        decision: "approved",
        decidedBy: "usr_arun",
      }),
    );

    expect(decided.ok).toBe(true);
  });

  it("refuses the requester approving their own action in approve mode", async () => {
    // "The user clicked yes" is not an authorization control when the user is
    // the attacker (doc 02 §1).
    const runId = await newRun();
    const approval = await request(runId, {
      mode: "approve",
      requestedBy: "usr_arun",
      decideByRole: "finance_admin",
    });

    const decided = await inOrg((scope) =>
      approvalsRepo.decideApproval(scope, {
        approvalId: approval.id,
        decision: "approved",
        decidedBy: "usr_arun",
        decidedByRoles: ["finance_admin"],
      }),
    );

    expect(decided.ok).toBe(false);
    if (decided.ok) return;
    expect(decided.reason).toBe("wrong_decider");
  });

  it("refuses a different principal who lacks the role", async () => {
    const runId = await newRun();
    const approval = await request(runId, {
      mode: "approve",
      requestedBy: "usr_arun",
      decideByRole: "finance_admin",
    });

    const decided = await inOrg((scope) =>
      approvalsRepo.decideApproval(scope, {
        approvalId: approval.id,
        decision: "approved",
        decidedBy: "usr_priya",
        decidedByRoles: ["support"],
      }),
    );

    expect(decided.ok).toBe(false);
  });

  it("accepts a different principal holding the role", async () => {
    const runId = await newRun();
    const approval = await request(runId, {
      mode: "approve",
      requestedBy: "usr_arun",
      decideByRole: "finance_admin",
    });

    const decided = await inOrg((scope) =>
      approvalsRepo.decideApproval(scope, {
        approvalId: approval.id,
        decision: "approved",
        decidedBy: "usr_priya",
        decidedByRoles: ["finance_admin"],
      }),
    );

    expect(decided.ok).toBe(true);
  });
});

describe("expiry", () => {
  it("expires a pending approval past its deadline, via a sweep", async () => {
    const runId = await newRun();
    const approval = await request(runId, { expiresInSeconds: -1 });

    const swept = await inOrg((scope) => approvalsRepo.sweepExpired(scope));

    expect(swept.map((a) => a.id)).toContain(approval.id);
    expect((await inOrg((scope) => approvalsRepo.getApproval(scope, approval.id)))?.state).toBe(
      "expired",
    );
  });

  it("refuses a decision on an approval that has already lapsed", async () => {
    const runId = await newRun();
    const approval = await request(runId, { expiresInSeconds: -1 });

    const decided = await inOrg((scope) =>
      approvalsRepo.decideApproval(scope, {
        approvalId: approval.id,
        decision: "approved",
        decidedBy: "usr_manager",
      }),
    );

    expect(decided.ok).toBe(false);
    if (decided.ok) return;
    expect(decided.reason).toBe("expired");
  });

  it("does not sweep an approval that is still in time", async () => {
    const runId = await newRun();
    const approval = await request(runId, { expiresInSeconds: 3600 });

    const swept = await inOrg((scope) => approvalsRepo.sweepExpired(scope));
    expect(swept.map((a) => a.id)).not.toContain(approval.id);
  });
});

describe("the runtime states are now reachable", () => {
  it("suspends on approval_required and resumes on approval_granted", () => {
    const suspended = transition("Authorizing", {
      type: "approval_required",
      approval_id: "apr_1",
      mode: "confirm",
    });
    expect(suspended).toBe("AwaitingApproval");
    expect(isTerminal(suspended)).toBe(false);

    expect(transition(suspended, { type: "approval_granted", approval_id: "apr_1" })).toBe(
      "Executing",
    );
  });

  it("routes a rejection to Denied and a lapse to Expired", () => {
    expect(transition("AwaitingApproval", { type: "approval_rejected", approval_id: "a" })).toBe(
      "Denied",
    );
    expect(transition("AwaitingApproval", { type: "approval_expired", approval_id: "a" })).toBe(
      "Expired",
    );
  });

  it("still accepts cancellation while suspended", () => {
    expect(transition("AwaitingApproval", { type: "cancelled" })).toBe("Cancelled");
  });

  it("replays a suspended-then-approved run to the same state", () => {
    // Replay is what makes the resume trustworthy: the log alone re-derives the
    // run, so a restarted process does not need anything it was holding.
    const steps = [
      { type: "approval", event: { type: "approval_required", approval_id: "a", mode: "confirm" } },
      { type: "approval", event: { type: "approval_granted", approval_id: "a" } },
    ].map((s, i) => ({
      id: `step_${i}`,
      seq: i + 3,
      run_id: "run_1",
      type: s.type,
      status: "ok" as const,
      integrity: "system" as const,
      payload: { event: s.event },
      started_at: 0,
    }));

    const prelude = [
      { type: "identity_verified" },
      { type: "context_assembled" },
      { type: "intent_resolved", intent: "open" },
      { type: "planned", action: "call_tool" },
      { type: "tool_selected" },
    ].map((event, i) => ({
      id: `p_${i}`,
      seq: i - 4,
      run_id: "run_1",
      type: "context",
      status: "ok" as const,
      integrity: "system" as const,
      payload: { event },
      started_at: 0,
    }));

    expect(replay("run_1", [...prelude, ...steps]).state).toBe("Executing");
  });
});
