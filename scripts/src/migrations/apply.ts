import type { Client } from "pg";
import { err, ok, type Result } from "../result.js";
import { discoverMigrations } from "./discover.js";
import { planMigrations } from "./plan.js";
import type { AppliedMigration, MigrateError, MigrationPlan } from "./types.js";

/**
 * Bootstrap DDL, owned by the runner rather than by 0001 — the runner has to be
 * able to read this table before any migration exists.
 *
 * Not tenant-scoped, so no org_id and no RLS. The application role is granted
 * nothing on it.
 */
const SCHEMA_MIGRATIONS_DDL = `
  create table if not exists schema_migrations (
    version      text primary key,
    name         text not null,
    filename     text not null,
    checksum     text not null check (checksum ~ '^[a-f0-9]{64}$'),
    applied_at   timestamptz not null default now(),
    duration_ms  integer not null check (duration_ms >= 0)
  );
  revoke all on schema_migrations from public;
`;

/** Fixed key so every runner against a database contends on the same lock. */
const ADVISORY_LOCK_KEY = 4_919_114_271_204_884_361n;

export type MigrateEvent =
  | { readonly kind: "up_to_date" }
  | { readonly kind: "applying"; readonly filename: string }
  | { readonly kind: "applied"; readonly migration: AppliedMigration }
  | { readonly kind: "would_apply"; readonly filename: string };

export type MigrateOptions = {
  readonly dir: string;
  readonly dryRun: boolean;
  readonly onEvent?: (event: MigrateEvent) => void;
};

export async function ensureSchemaMigrationsTable(client: Client): Promise<void> {
  await client.query(SCHEMA_MIGRATIONS_DDL);
}

export async function readAppliedMigrations(client: Client): Promise<readonly AppliedMigration[]> {
  const result = await client.query<{
    version: string;
    name: string;
    filename: string;
    checksum: string;
    applied_at: Date;
    duration_ms: number;
  }>(
    `select version, name, filename, checksum, applied_at, duration_ms
       from schema_migrations
      order by version`,
  );

  return result.rows.map((row) => ({
    version: row.version,
    name: row.name,
    filename: row.filename,
    checksum: row.checksum,
    appliedAt: row.applied_at,
    durationMs: row.duration_ms,
  }));
}

function pgCodeOf(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
  const { code } = cause as { code: unknown };
  return typeof code === "string" ? code : undefined;
}

/**
 * Discover, validate, then apply. Holds an advisory lock for the whole run so
 * two runners cannot interleave, and wraps each migration together with its
 * schema_migrations row in one transaction so a failure leaves no partial
 * record.
 */
export async function migrate(
  client: Client,
  options: MigrateOptions,
): Promise<Result<MigrationPlan, MigrateError>> {
  const locked = await client.query<{ acquired: boolean }>(
    "select pg_try_advisory_lock($1::bigint) as acquired",
    [ADVISORY_LOCK_KEY.toString()],
  );
  if (locked.rows[0]?.acquired !== true) return err({ kind: "lock_unavailable" });

  try {
    await ensureSchemaMigrationsTable(client);

    const files = await discoverMigrations(options.dir);
    if (!files.ok) return files;

    const applied = await readAppliedMigrations(client);
    const planned = planMigrations(files.value, applied);
    if (!planned.ok) return planned;

    const plan = planned.value;

    if (plan.pending.length === 0) {
      options.onEvent?.({ kind: "up_to_date" });
      return ok(plan);
    }

    if (options.dryRun) {
      for (const file of plan.pending) {
        options.onEvent?.({ kind: "would_apply", filename: file.filename });
      }
      return ok(plan);
    }

    const newlyApplied: AppliedMigration[] = [];

    for (const file of plan.pending) {
      options.onEvent?.({ kind: "applying", filename: file.filename });
      const startedAt = Date.now();

      try {
        await client.query("begin");
        await client.query(file.sql);
        const durationMs = Date.now() - startedAt;
        await client.query(
          `insert into schema_migrations (version, name, filename, checksum, duration_ms)
           values ($1, $2, $3, $4, $5)`,
          [file.version, file.name, file.filename, file.checksum, durationMs],
        );
        await client.query("commit");

        const migration: AppliedMigration = {
          version: file.version,
          name: file.name,
          filename: file.filename,
          checksum: file.checksum,
          appliedAt: new Date(),
          durationMs,
        };
        newlyApplied.push(migration);
        options.onEvent?.({ kind: "applied", migration });
      } catch (cause) {
        await client.query("rollback").catch(() => undefined);
        return err({
          kind: "apply_failed",
          version: file.version,
          filename: file.filename,
          pgCode: pgCodeOf(cause),
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }

    return ok({ applied: [...plan.applied, ...newlyApplied], pending: [] });
  } finally {
    await client.query("select pg_advisory_unlock($1::bigint)", [ADVISORY_LOCK_KEY.toString()]);
  }
}
