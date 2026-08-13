import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, describeMigrateError, migrate, resolveDatabaseUrl } from "@keel/scripts";
import { Client } from "pg";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "migrations",
);

export type TestDatabase = {
  readonly name: string;
  /** A real LOGIN role granted keel_app. Not a superuser, not the table owner. */
  readonly appRole: string;
  readonly adminUrl: string;
  readonly appUrl: string;
  connectAsAdmin(): Promise<Client>;
  connectAsApp(): Promise<Client>;
  drop(): Promise<void>;
};

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function withCredentials(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  return parsed.toString();
}

/**
 * Provisions a throwaway database, migrates it, and creates a dedicated LOGIN
 * role for it.
 *
 * The role matters as much as the database. Assertions run over a genuine
 * second connection authenticated as a non-superuser, rather than SET ROLE from
 * a privileged session — otherwise a passing RLS test proves less than it looks
 * like it proves.
 */
export async function provisionTestDatabase(label: string): Promise<TestDatabase> {
  const suffix = randomBytes(6).toString("hex");
  const name = `keel_test_${label}_${suffix}`.toLowerCase().slice(0, 63);
  const appRole = `${name}_app`.slice(0, 63);
  const password = randomBytes(24).toString("hex");

  const baseUrl = resolveDatabaseUrl();
  const maintenanceUrl = withDatabase(baseUrl, "postgres");

  const maintenance = new Client({
    connectionString: maintenanceUrl,
    connectionTimeoutMillis: 10_000,
  });
  await maintenance.connect();
  try {
    await maintenance.query(`create database "${name}"`);
  } finally {
    await maintenance.end();
  }

  const adminUrl = withDatabase(baseUrl, name);

  const migrator = await connect(adminUrl);
  try {
    const result = await migrate(migrator, { dir: MIGRATIONS_DIR, dryRun: false });
    if (!result.ok) throw new Error(`migrating ${name}: ${describeMigrateError(result.error)}`);
  } finally {
    await migrator.end();
  }

  const admin = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 10_000 });
  await admin.connect();
  try {
    await admin.query(`create role "${appRole}" login password '${password}' in role keel_app`);
    await admin.query(`grant connect on database "${name}" to "${appRole}"`);
  } finally {
    await admin.end();
  }

  const appUrl = withCredentials(adminUrl, appRole, password);

  const connectAsAdmin = async (): Promise<Client> => {
    const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 10_000 });
    await client.connect();
    return client;
  };

  const connectAsApp = async (): Promise<Client> => {
    const client = new Client({ connectionString: appUrl, connectionTimeoutMillis: 10_000 });
    await client.connect();
    return client;
  };

  const drop = async (): Promise<void> => {
    const cleanup = new Client({
      connectionString: maintenanceUrl,
      connectionTimeoutMillis: 10_000,
    });
    await cleanup.connect();
    try {
      await cleanup.query(`drop database if exists "${name}" with (force)`);
      await cleanup.query(`drop role if exists "${appRole}"`);
    } finally {
      await cleanup.end();
    }
  };

  return { name, appRole, adminUrl, appUrl, connectAsAdmin, connectAsApp, drop };
}

/** SET does not take bind parameters; this is the mechanism the policies read. */
export async function setSessionOrg(client: Client, orgId: string | null): Promise<void> {
  await client.query("select set_config('keel.org_id', $1, false)", [orgId ?? ""]);
}

export async function setSessionUser(client: Client, userId: string | null): Promise<void> {
  await client.query("select set_config('keel.user_id', $1, false)", [userId ?? ""]);
}
