import {
  agentsRepo,
  conversationsRepo,
  createPool,
  identityRepo,
  type OrgScope,
  runsRepo,
  toolsRepo,
  withOrgScope,
} from "@keel/api";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionTestDatabase, type TestDatabase } from "./helpers/database.js";
import { type SeededOrg, seedOrg } from "./helpers/seed.js";

let db: TestDatabase;
let pool: Pool;
let orgA: SeededOrg;
let orgB: SeededOrg;

/** Runs `fn` in org A's scope. Every test below goes through this. */
const inA = <T>(fn: (scope: OrgScope) => Promise<T>): Promise<T> =>
  withOrgScope(pool, orgA.orgId, fn);
const inB = <T>(fn: (scope: OrgScope) => Promise<T>): Promise<T> =>
  withOrgScope(pool, orgB.orgId, fn);

async function seedAgentVersion(): Promise<{ agentId: string; versionId: string }> {
  return inA(async (scope) => {
    const agent = await agentsRepo.createAgent(scope, {
      projectId: orgA.projectId,
      name: "Support",
      slug: `support-${Math.random().toString(36).slice(2, 8)}`,
    });
    const version = await agentsRepo.publishAgentVersion(scope, {
      agentId: agent.id,
      instructions: "Help the customer.",
    });
    return { agentId: agent.id, versionId: version.id };
  });
}

beforeAll(async () => {
  db = await provisionTestDatabase("repos");
  pool = createPool(db.appUrl);

  const seeder = await db.connectAsApp();
  try {
    orgA = await seedOrg(seeder, { slug: "alpha", email: "owner@alpha.example" });
    orgB = await seedOrg(seeder, { slug: "bravo", email: "owner@bravo.example" });
  } finally {
    await seeder.end();
  }
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

describe("withOrgScope", () => {
  it("sets keel.org_id on the transaction, so RLS is already active", async () => {
    const setting = await inA(async (scope) => {
      const rows = await scope.client.query<{ org: string }>(
        "select current_setting('keel.org_id', true) as org",
      );
      return rows.rows[0]?.org;
    });

    expect(setting).toBe(orgA.orgId);
  });

  it("discards the setting when the transaction ends, so a pooled connection cannot leak a tenant", async () => {
    await inA(async () => undefined);

    const client = await pool.connect();
    try {
      const rows = await client.query<{ org: string | null }>(
        "select current_setting('keel.org_id', true) as org",
      );
      // Postgres resets a transaction-local GUC to the empty string rather than
      // unsetting it. That is exactly why keel_current_org_id() wraps it in
      // nullif(..., '') — both spellings must mean "no tenant".
      expect(rows.rows[0]?.org ?? "").toBe("");

      const effective = await client.query<{ org: string | null }>(
        "select keel_current_org_id() as org",
      );
      expect(effective.rows[0]?.org).toBeNull();
    } finally {
      client.release();
    }
  });

  it("rolls back on failure", async () => {
    const before = await inA((scope) => agentsRepo.listAgents(scope, orgA.projectId));

    await expect(
      inA(async (scope) => {
        await agentsRepo.createAgent(scope, {
          projectId: orgA.projectId,
          name: "Doomed",
          slug: "doomed",
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const after = await inA((scope) => agentsRepo.listAgents(scope, orgA.projectId));
    expect(after).toHaveLength(before.length);
  });

  it("refuses an empty org id rather than opening an unscoped transaction", async () => {
    await expect(withOrgScope(pool, "", async () => undefined)).rejects.toThrow(/non-empty org id/);
  });
});

describe("agents repository", () => {
  it("creates, reads, lists, renames and deletes", async () => {
    await inA(async (scope) => {
      const created = await agentsRepo.createAgent(scope, {
        projectId: orgA.projectId,
        name: "Billing",
        slug: "billing",
      });
      expect(created.id).toMatch(/^agt_[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(created.org_id).toBe(orgA.orgId);

      expect((await agentsRepo.getAgent(scope, created.id))?.name).toBe("Billing");
      expect(await agentsRepo.listAgents(scope, orgA.projectId)).not.toHaveLength(0);

      const renamed = await agentsRepo.renameAgent(scope, created.id, "Billing v2");
      expect(renamed?.name).toBe("Billing v2");

      expect(await agentsRepo.deleteAgent(scope, created.id)).toBe(true);
      expect(await agentsRepo.getAgent(scope, created.id)).toBeUndefined();
    });
  });

  it("numbers versions sequentially and moves the pointer", async () => {
    await inA(async (scope) => {
      const agent = await agentsRepo.createAgent(scope, {
        projectId: orgA.projectId,
        name: "Versioned",
        slug: "versioned",
      });

      const v1 = await agentsRepo.publishAgentVersion(scope, {
        agentId: agent.id,
        instructions: "first",
      });
      const v2 = await agentsRepo.publishAgentVersion(scope, {
        agentId: agent.id,
        instructions: "second",
      });

      expect(v1.version).toBe(1);
      expect(v2.version).toBe(2);
      expect((await agentsRepo.getAgent(scope, agent.id))?.current_version_id).toBe(v2.id);
      expect(await agentsRepo.listAgentVersions(scope, agent.id)).toHaveLength(2);
    });
  });

  it("cannot see another org's agents", async () => {
    const agentInA = await inA((scope) =>
      agentsRepo.createAgent(scope, {
        projectId: orgA.projectId,
        name: "Private",
        slug: "private",
      }),
    );

    const seenFromB = await inB((scope) => agentsRepo.getAgent(scope, agentInA.id));
    expect(seenFromB).toBeUndefined();
  });
});

describe("insert-only version tables", () => {
  it("raises when the owner updates an agent version", async () => {
    const { versionId } = await seedAgentVersion();

    // Deliberately the owner connection: the app role is denied by privilege
    // before the trigger is ever consulted, so testing through it would prove
    // the grant works and say nothing about the trigger. The trigger is the
    // layer that protects a caller who *does* hold UPDATE — including a future
    // migration running as the owner.
    const admin = await db.connectAsAdmin();
    try {
      await admin.query("select set_config('keel.org_id', $1, false)", [orgA.orgId]);
      await expect(
        admin.query("update agent_versions set instructions = 'rewritten' where id = $1", [
          versionId,
        ]),
      ).rejects.toThrow(/insert-only/);
    } finally {
      await admin.end();
    }
  });

  it("denies the app role by privilege before the trigger is reached", async () => {
    const { versionId } = await seedAgentVersion();

    await expect(
      inA(async (scope) => {
        await scope.client.query("update agent_versions set instructions = 'x' where id = $1", [
          versionId,
        ]);
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it("raises when the owner updates a tool version", async () => {
    const versionId = await inA(async (scope) => {
      const tool = await toolsRepo.createTool(scope, {
        projectId: orgA.projectId,
        name: "get_customer",
        target: "openapi",
      });
      const version = await toolsRepo.publishToolVersion(scope, {
        toolId: tool.id,
        contract: { name: "get_customer" },
        source: "openapi",
        checksum: "a".repeat(64),
      });
      return version.id;
    });

    const admin = await db.connectAsAdmin();
    try {
      await admin.query("select set_config('keel.org_id', $1, false)", [orgA.orgId]);
      await expect(
        admin.query("update tool_versions set source = 'mcp' where id = $1", [versionId]),
      ).rejects.toThrow(/insert-only/);
    } finally {
      await admin.end();
    }
  });

  it("denies UPDATE by privilege as well, so the invariant survives losing the trigger", async () => {
    const granted = await inA(async (scope) => {
      const rows = await scope.client.query<{ privilege_type: string }>(
        `select privilege_type from information_schema.role_table_grants
          where table_name = 'agent_versions' and grantee = 'keel_app'`,
      );
      return rows.rows.map((r) => r.privilege_type).sort();
    });

    expect(granted).toEqual(["INSERT", "SELECT"]);
  });
});

describe("tools repository", () => {
  it("creates a tool disabled by default", async () => {
    await inA(async (scope) => {
      const tool = await toolsRepo.createTool(scope, {
        projectId: orgA.projectId,
        name: "list_invoices",
        target: "openapi",
      });

      expect(tool.enabled).toBe(false);

      const enabled = await toolsRepo.setToolEnabled(scope, tool.id, true);
      expect(enabled?.enabled).toBe(true);

      expect(await toolsRepo.listTools(scope, orgA.projectId, { enabledOnly: true })).toHaveLength(
        1,
      );
    });
  });

  it("binds a tool version to an environment and stores a secret ref, not a secret", async () => {
    await inA(async (scope) => {
      const tool = await toolsRepo.createTool(scope, {
        projectId: orgA.projectId,
        name: "cancel_subscription",
        target: "openapi",
      });
      const version = await toolsRepo.publishToolVersion(scope, {
        toolId: tool.id,
        contract: { name: "cancel_subscription" },
        source: "openapi",
        checksum: "b".repeat(64),
      });

      const binding = await toolsRepo.bindTool(scope, {
        toolVersionId: version.id,
        environmentId: orgA.environmentId,
        baseUrl: "https://api.northwind.example",
        secretRef: "env://NORTHWIND_TOKEN",
      });

      expect(binding.secret_ref).toBe("env://NORTHWIND_TOKEN");
      expect(binding.enabled).toBe(false);
      expect(await toolsRepo.listBindings(scope, orgA.environmentId)).toHaveLength(1);
    });
  });

  it("rejects a plaintext secret at the database, not in review", async () => {
    await expect(
      inA(async (scope) => {
        const tool = await toolsRepo.createTool(scope, {
          projectId: orgA.projectId,
          name: "leaky",
          target: "server",
        });
        const version = await toolsRepo.publishToolVersion(scope, {
          toolId: tool.id,
          contract: {},
          source: "native",
          checksum: "c".repeat(64),
        });
        await toolsRepo.bindTool(scope, {
          toolVersionId: version.id,
          environmentId: orgA.environmentId,
          secretRef: "sk-live-abcdef123456",
        });
      }),
    ).rejects.toThrow(/violates check constraint/);
  });
});

describe("conversations repository", () => {
  it("creates a conversation, appends messages and advances the activity clock", async () => {
    const { versionId } = await seedAgentVersion();

    await inA(async (scope) => {
      const conversation = await conversationsRepo.createConversation(scope, {
        projectId: orgA.projectId,
        environmentId: orgA.environmentId,
        agentVersionId: versionId,
        title: "Refund question",
      });

      const before = conversation.last_activity_at;

      await conversationsRepo.appendMessage(scope, {
        conversationId: conversation.id,
        role: "user",
        content: "How do refunds work?",
      });
      await conversationsRepo.appendMessage(scope, {
        conversationId: conversation.id,
        role: "assistant",
        content: "Within seven days on monthly plans.",
      });

      const messages = await conversationsRepo.listMessages(scope, conversation.id);
      expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);

      const after = await conversationsRepo.getConversation(scope, conversation.id);
      expect(after?.last_activity_at.getTime()).toBeGreaterThanOrEqual(before.getTime());

      expect((await conversationsRepo.closeConversation(scope, conversation.id))?.status).toBe(
        "closed",
      );
      expect(await conversationsRepo.deleteConversation(scope, conversation.id)).toBe(true);
    });
  });
});

describe("runs repository", () => {
  it("records a run, appends ordered steps and accumulates totals", async () => {
    const { versionId } = await seedAgentVersion();

    await inA(async (scope) => {
      const run = await runsRepo.createRun(scope, {
        projectId: orgA.projectId,
        environmentId: orgA.environmentId,
        agentVersionId: versionId,
        trigger: "chat",
      });

      await runsRepo.appendStep(scope, {
        runId: run.id,
        type: "context",
        status: "ok",
        tokensIn: 100,
      });
      await runsRepo.appendStep(scope, {
        runId: run.id,
        type: "model",
        status: "ok",
        tokensIn: 50,
        tokensOut: 25,
        costUsd: 0.002,
        model: "claude-sonnet",
      });
      await runsRepo.appendStep(scope, {
        runId: run.id,
        type: "response",
        status: "ok",
      });

      const steps = await runsRepo.listSteps(scope, run.id);
      expect(steps.map((s) => s.seq)).toEqual([1, 2, 3]);
      expect(steps.map((s) => s.type)).toEqual(["context", "model", "response"]);

      const updated = await runsRepo.getRun(scope, run.id);
      expect(updated?.tokens_in).toBe(150);
      expect(updated?.tokens_out).toBe(25);
      expect(Number(updated?.cost_usd)).toBeCloseTo(0.002, 6);

      const ended = await runsRepo.endRun(scope, run.id, { state: "Completed" });
      expect(ended?.ended_at).not.toBeNull();
    });
  });

  it("allocates seq from the run counter, so it is unique per run regardless of partition", async () => {
    const { versionId } = await seedAgentVersion();

    const seqs = await inA(async (scope) => {
      const run = await runsRepo.createRun(scope, {
        projectId: orgA.projectId,
        environmentId: orgA.environmentId,
        agentVersionId: versionId,
        trigger: "api",
      });

      const written: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const step = await runsRepo.appendStep(scope, {
          runId: run.id,
          type: "tool",
          status: "ok",
        });
        written.push(step.seq);
      }
      return written;
    });

    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("refuses a second run with the same idempotency key", async () => {
    const { versionId } = await seedAgentVersion();

    const start = (key: string) =>
      inA((scope) =>
        runsRepo.createRun(scope, {
          projectId: orgA.projectId,
          environmentId: orgA.environmentId,
          agentVersionId: versionId,
          trigger: "api",
          idempotencyKey: key,
        }),
      );

    const first = await start("idem-0001");
    await expect(start("idem-0001")).rejects.toThrow(/duplicate key|unique/i);

    const found = await inA((scope) =>
      runsRepo.findRunByIdempotencyKey(scope, orgA.projectId, "idem-0001"),
    );
    expect(found?.id).toBe(first.id);
  });

  it("has no update or delete path for steps — a correction is a new step", () => {
    expect("updateStep" in runsRepo).toBe(false);
    expect("deleteStep" in runsRepo).toBe(false);
  });

  it("denies UPDATE and DELETE on run_steps by privilege", async () => {
    const granted = await inA(async (scope) => {
      const rows = await scope.client.query<{ privilege_type: string }>(
        `select privilege_type from information_schema.role_table_grants
          where table_name = 'run_steps' and grantee = 'keel_app'`,
      );
      return rows.rows.map((r) => r.privilege_type).sort();
    });

    expect(granted).toEqual(["INSERT", "SELECT"]);
  });

  it("cannot read another org's run", async () => {
    const { versionId } = await seedAgentVersion();
    const run = await inA((scope) =>
      runsRepo.createRun(scope, {
        projectId: orgA.projectId,
        environmentId: orgA.environmentId,
        agentVersionId: versionId,
        trigger: "chat",
      }),
    );

    expect(await inB((scope) => runsRepo.getRun(scope, run.id))).toBeUndefined();
    expect(await inB((scope) => runsRepo.listSteps(scope, run.id))).toEqual([]);
  });
});

describe("identity repository", () => {
  it("stores a claims digest and never the claims", async () => {
    await inA(async (scope) => {
      const claims = { email: "arun@northwind.example", role: "admin", tenant: "acme" };
      const identity = await identityRepo.recordIdentity(scope, {
        projectId: orgA.projectId,
        subject: "user-42",
        claims,
      });

      expect(identity.claims_digest).toMatch(/^[a-f0-9]{64}$/);

      const stored = JSON.stringify(identity);
      expect(stored).not.toContain("arun@northwind.example");
      expect(stored).not.toContain("acme");
    });
  });

  it("digests the same claims identically regardless of key order", () => {
    const a = identityRepo.digestClaims({ b: 2, a: 1 });
    const b = identityRepo.digestClaims({ a: 1, b: 2 });

    expect(a).toBe(b);
  });

  it("moves last_seen_at on a repeat sighting rather than inserting again", async () => {
    await inA(async (scope) => {
      const first = await identityRepo.recordIdentity(scope, {
        projectId: orgA.projectId,
        subject: "returning-user",
        claims: { sub: "returning-user" },
      });
      const second = await identityRepo.recordIdentity(scope, {
        projectId: orgA.projectId,
        subject: "returning-user",
        claims: { sub: "returning-user" },
      });

      expect(second.id).toBe(first.id);
      expect(second.last_seen_at.getTime()).toBeGreaterThanOrEqual(first.first_seen_at.getTime());
    });
  });

  it("rejects an identity config with an empty algorithm list", async () => {
    await expect(
      inA(async (scope) => {
        await scope.client.query(
          `insert into identity_configs (org_id, project_id, issuer, jwks_uri, audience, algorithms)
           values ($1, $2, 'https://idp.example', 'https://idp.example/jwks', 'keel', '{}')`,
          [orgA.orgId, orgA.projectId],
        );
      }),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("rejects HS256 unless symmetric signing was explicitly enabled", async () => {
    await expect(
      inA(async (scope) => {
        await scope.client.query(
          `insert into identity_configs
             (org_id, project_id, issuer, jwks_uri, audience, algorithms, allow_symmetric)
           values ($1, $2, 'https://idp.example', 'https://idp.example/jwks', 'keel',
                   '{HS256}', false)`,
          [orgA.orgId, orgA.projectId],
        );
      }),
    ).rejects.toThrow(/violates check constraint/);
  });
});
