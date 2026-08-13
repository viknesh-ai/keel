import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, migrate, readAppliedMigrations } from "@keel/scripts";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionTestDatabase, type TestDatabase } from "./helpers/database.js";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

let db: TestDatabase;
let scratch = "";

beforeAll(async () => {
  // provisionTestDatabase already runs migrate() once against a fresh database,
  // so reaching this point is the "applies cleanly from empty" assertion.
  db = await provisionTestDatabase("migrate");
  scratch = await mkdtemp(join(tmpdir(), "keel-migrations-"));
  await cp(MIGRATIONS_DIR, scratch, { recursive: true });
});

afterAll(async () => {
  if (scratch !== "") await rm(scratch, { recursive: true, force: true });
  await db?.drop();
});

async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = await connect(db.adminUrl);
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

describe("migrate", () => {
  it("records 0001 as applied on a fresh database", async () => {
    const applied = await withClient(readAppliedMigrations);

    expect(applied.map((row) => row.filename)).toEqual(["0001_init.sql"]);
    expect(applied[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is a no-op when run a second time", async () => {
    const before = await withClient(readAppliedMigrations);

    const result = await withClient((client) =>
      migrate(client, { dir: MIGRATIONS_DIR, dryRun: false }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pending).toEqual([]);

    const after = await withClient(readAppliedMigrations);
    expect(after).toEqual(before);
  });

  it("rejects a migration file that changed after it was applied", async () => {
    const tampered = join(scratch, "0001_init.sql");
    const original = await readFile(tampered, "utf8");
    await writeFile(tampered, `${original}\n-- tampered\n`);

    const result = await withClient((client) => migrate(client, { dir: scratch, dryRun: false }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      kind: "checksum_mismatch",
      version: "0001",
      filename: "0001_init.sql",
    });

    await writeFile(tampered, original);
  });

  it("applies nothing at all when one file is tampered with", async () => {
    const tampered = join(scratch, "0001_init.sql");
    const original = await readFile(tampered, "utf8");
    await writeFile(tampered, `${original}\n-- tampered\n`);
    await writeFile(join(scratch, "0002_later.sql"), "create table should_not_exist (id text);\n");

    const result = await withClient((client) => migrate(client, { dir: scratch, dryRun: false }));
    expect(result.ok).toBe(false);

    const exists = await withClient((client) =>
      client.query("select to_regclass('public.should_not_exist') as t"),
    );
    expect(exists.rows[0]?.t).toBeNull();

    await writeFile(tampered, original);
    await rm(join(scratch, "0002_later.sql"));
  });

  it("rejects a migration inserted below the highest applied version", async () => {
    // 0001 is applied; add 0002, apply it, then try to slip 0001a in as 0002's
    // predecessor by renumbering. Simulated by applying 0002 then adding 0000.
    await writeFile(join(scratch, "0002_second.sql"), "create table second (id text);\n");
    const applied = await withClient((client) => migrate(client, { dir: scratch, dryRun: false }));
    expect(applied.ok).toBe(true);

    await writeFile(join(scratch, "0000_sneaked_in.sql"), "create table sneaked (id text);\n");
    const result = await withClient((client) => migrate(client, { dir: scratch, dryRun: false }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      kind: "out_of_order",
      version: "0000",
      highestApplied: "0002",
    });

    await rm(join(scratch, "0000_sneaked_in.sql"));
  });

  it("leaves no schema_migrations row when a migration raises", async () => {
    await writeFile(
      join(scratch, "0003_broken.sql"),
      "create table broken (id text) syntax err;\n",
    );

    const result = await withClient((client) => migrate(client, { dir: scratch, dryRun: false }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("apply_failed");

    const applied = await withClient(readAppliedMigrations);
    expect(applied.map((row) => row.version)).toEqual(["0001", "0002"]);

    const exists = await withClient((client) =>
      client.query("select to_regclass('public.broken') as t"),
    );
    expect(exists.rows[0]?.t).toBeNull();

    await rm(join(scratch, "0003_broken.sql"));
  });

  it("changes nothing on a dry run", async () => {
    await writeFile(join(scratch, "0004_dry.sql"), "create table dry (id text);\n");

    const result = await withClient((client) => migrate(client, { dir: scratch, dryRun: true }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pending.map((file) => file.filename)).toEqual(["0004_dry.sql"]);

    const exists = await withClient((client) =>
      client.query("select to_regclass('public.dry') as t"),
    );
    expect(exists.rows[0]?.t).toBeNull();

    await rm(join(scratch, "0004_dry.sql"));
  });
});
