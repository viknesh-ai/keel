import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  provisionTestDatabase,
  setSessionOrg,
  setSessionUser,
  type TestDatabase,
} from "./helpers/database.js";
import { type SeededOrg, seedOrg } from "./helpers/seed.js";

const TENANT_TABLES = [
  "api_keys",
  "environments",
  "memberships",
  "organizations",
  "projects",
  "users",
] as const;

/** Postgres raises this when a WITH CHECK clause rejects a row. */
const INSUFFICIENT_PRIVILEGE = "42501";
const FOREIGN_KEY_VIOLATION = "23503";

let db: TestDatabase;
let app: Client;
let orgA: SeededOrg;
let orgB: SeededOrg;

beforeAll(async () => {
  db = await provisionTestDatabase("rls");

  // Seeded through the app role, so every WITH CHECK clause is exercised.
  const seeder = await db.connectAsApp();
  try {
    orgA = await seedOrg(seeder, { slug: "alpha", email: "owner@alpha.example" });
    orgB = await seedOrg(seeder, { slug: "bravo", email: "owner@bravo.example" });
  } finally {
    await seeder.end();
  }

  app = await db.connectAsApp();
});

afterAll(async () => {
  await app?.end();
  await db?.drop();
});

// If any of these fail, every assertion below would pass for the wrong reason.
describe("the connection under test cannot bypass RLS", () => {
  it("is not a superuser and does not hold BYPASSRLS", async () => {
    const result = await app.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "select rolsuper, rolbypassrls from pg_roles where rolname = current_user",
    );

    expect(result.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("does not own the tenant tables", async () => {
    const result = await app.query<{ tablename: string; tableowner: string; me: string }>(
      `select tablename, tableowner, current_user as me
         from pg_tables
        where schemaname = 'public' and tablename = any($1)`,
      [[...TENANT_TABLES]],
    );

    expect(result.rows).toHaveLength(TENANT_TABLES.length);
    for (const row of result.rows) expect(row.tableowner).not.toBe(row.me);
  });

  it("has row level security enabled AND forced on every tenant table", async () => {
    const result = await app.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `select relname, relrowsecurity, relforcerowsecurity
         from pg_class
        where relnamespace = 'public'::regnamespace and relname = any($1)
        order by relname`,
      [[...TENANT_TABLES]],
    );

    expect(result.rows).toEqual(
      TENANT_TABLES.map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
      })),
    );
  });

  // The guard against a future migration adding `USING (true)`, widening a
  // predicate, or dropping a WITH CHECK.
  //
  // Asserted by shape rather than as a hardcoded list of every policy: a fixed
  // list has to be edited on every migration, and an assertion people routinely
  // edit to make green stops being an assertion. This version additionally
  // catches a *new* table shipped with a bad policy, which a fixed list would
  // not — it would just be absent from the list.
  it("gives every tenant table exactly the org-isolation predicate", async () => {
    const result = await app.query<{
      tablename: string;
      policyname: string;
      permissive: string;
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `select tablename, policyname, permissive, cmd, qual, with_check
         from pg_policies
        where schemaname = 'public'
        order by tablename, policyname`,
    );

    const normalise = (e: string | null): string | null =>
      e === null ? null : e.replace(/\s+/g, " ").trim();

    // `users` is not tenant-scoped — it is keyed on keel.user_id and its
    // policies are split per command. Everything else is org-isolated on a
    // local org_id column.
    const ORG_ISOLATION = new Set([
      "(org_id = keel_current_org_id())",
      "(id = keel_current_org_id())",
    ]);

    expect(result.rows.length).toBeGreaterThan(0);

    for (const row of result.rows) {
      if (row.tablename === "users") continue;

      expect(row.permissive, `${row.policyname} must be permissive`).toBe("PERMISSIVE");
      expect(row.cmd, `${row.policyname} must cover ALL commands`).toBe("ALL");
      expect(
        ORG_ISOLATION.has(normalise(row.qual) ?? ""),
        `${row.tablename}.${row.policyname} USING is "${normalise(row.qual)}", not an org-isolation predicate`,
      ).toBe(true);
      expect(
        ORG_ISOLATION.has(normalise(row.with_check) ?? ""),
        `${row.tablename}.${row.policyname} WITH CHECK is "${normalise(row.with_check)}", not an org-isolation predicate`,
      ).toBe(true);
    }
  });

  it("keeps the documented per-command split on users", async () => {
    const result = await app.query<{ policyname: string; cmd: string }>(
      "select policyname, cmd from pg_policies where tablename = 'users' order by policyname",
    );

    expect(result.rows).toEqual([
      { policyname: "users_delete_self", cmd: "DELETE" },
      { policyname: "users_insert_self", cmd: "INSERT" },
      { policyname: "users_select_self_or_co_member", cmd: "SELECT" },
      { policyname: "users_update_self", cmd: "UPDATE" },
    ]);
  });
});

describe("a session scoped to org A", () => {
  beforeAll(async () => {
    await setSessionOrg(app, orgA.orgId);
    await setSessionUser(app, orgA.userId);
  });

  it("cannot select org B's project by its id", async () => {
    const result = await app.query("select * from projects where id = $1", [orgB.projectId]);

    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
  });

  it("sees only its own project when selecting the whole table", async () => {
    const result = await app.query<{ id: string }>("select id from projects");

    expect(result.rows.map((row) => row.id)).toEqual([orgA.projectId]);
  });

  it("sees only its own organization row", async () => {
    const result = await app.query<{ id: string }>("select id from organizations");

    expect(result.rows.map((row) => row.id)).toEqual([orgA.orgId]);
  });

  it("cannot read org B's environments or api key hash", async () => {
    const environments = await app.query("select id from environments where id = $1", [
      orgB.environmentId,
    ]);
    const apiKeys = await app.query("select hash from api_keys where id = $1", [orgB.apiKeyId]);

    expect(environments.rows).toEqual([]);
    expect(apiKeys.rows).toEqual([]);
  });

  it("cannot see org B's user, even though users is a global table", async () => {
    const byId = await app.query("select id from users where id = $1", [orgB.userId]);
    const all = await app.query<{ id: string }>("select id from users");

    expect(byId.rows).toEqual([]);
    expect(all.rows.map((row) => row.id)).toEqual([orgA.userId]);
  });

  it("cannot insert a project into org B", async () => {
    await expect(
      app.query("insert into projects (org_id, name, slug) values ($1, 'x', 'x')", [orgB.orgId]),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });

  it("cannot move one of its own projects into org B", async () => {
    await expect(
      app.query("update projects set org_id = $1 where id = $2", [orgB.orgId, orgA.projectId]),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });

  it("silently affects zero rows when updating or deleting org B's project", async () => {
    const updated = await app.query("update projects set name = 'hijacked' where id = $1", [
      orgB.projectId,
    ]);
    const deleted = await app.query("delete from projects where id = $1", [orgB.projectId]);

    expect(updated.rowCount).toBe(0);
    expect(deleted.rowCount).toBe(0);
  });

  it("cannot update org B's user row", async () => {
    const updated = await app.query("update users set name = 'hijacked' where id = $1", [
      orgB.userId,
    ]);

    expect(updated.rowCount).toBe(0);
  });

  it("leaves org B's rows untouched after all of the above", async () => {
    const other = await db.connectAsApp();
    try {
      await setSessionOrg(other, orgB.orgId);
      const projects = await other.query<{ id: string; name: string }>(
        "select id, name from projects",
      );

      expect(projects.rows).toEqual([{ id: orgB.projectId, name: "Project bravo" }]);
    } finally {
      await other.end();
    }
  });
});

// Not a policy failure — a documented limitation, asserted so that nobody
// mistakes an admin-connected query for evidence that RLS is working.
describe("the superuser bypass is real", () => {
  it("sees every organization's rows even with an org set and FORCE enabled", async () => {
    const admin = await db.connectAsAdmin();
    try {
      const role = await admin.query<{ rolsuper: boolean }>(
        "select rolsuper from pg_roles where rolname = current_user",
      );
      expect(role.rows[0]?.rolsuper).toBe(true);

      await setSessionOrg(admin, orgA.orgId);
      const projects = await admin.query<{ id: string }>("select id from projects order by id");

      expect(projects.rows.map((row) => row.id).sort()).toEqual(
        [orgA.projectId, orgB.projectId].sort(),
      );
    } finally {
      await admin.end();
    }
  });
});

describe("a session with no organization set", () => {
  beforeAll(async () => {
    await setSessionOrg(app, null);
    await setSessionUser(app, null);
  });

  it.each(TENANT_TABLES)("reads zero rows from %s", async (table) => {
    const result = await app.query(`select * from ${table}`);

    expect(result.rows).toEqual([]);
  });

  it("cannot insert into a tenant table", async () => {
    await expect(
      app.query("insert into projects (org_id, name, slug) values ($1, 'x', 'x')", [orgA.orgId]),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });
});

describe("the denormalised org_id cannot diverge from its project", () => {
  it("rejects an environment claiming org A while pointing at org B's project", async () => {
    // Run as the owner with org B's context, so the failure is the composite
    // foreign key rather than RLS.
    const admin = await db.connectAsAdmin();
    try {
      await setSessionOrg(admin, orgA.orgId);
      await expect(
        admin.query(
          "insert into environments (org_id, project_id, name) values ($1, $2, 'staging')",
          [orgA.orgId, orgB.projectId],
        ),
      ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    } finally {
      await admin.end();
    }
  });
});
