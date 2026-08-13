import { Client } from "pg";

/** Matches .env.example and docker-compose.yml. */
const COMPOSE_DEFAULT_URL = "postgres://keel:keel@localhost:5432/keel";

export type ConnectOptions = {
  readonly statementTimeoutMs?: number;
};

const DEFAULT_STATEMENT_TIMEOUT_MS = 300_000;
const CONNECT_TIMEOUT_MS = 10_000;
const LOCK_TIMEOUT_MS = 10_000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

export function resolveDatabaseUrl(override?: string): string {
  return override ?? process.env["DATABASE_URL"] ?? COMPOSE_DEFAULT_URL;
}

/** Never log a DSN without this. */
export function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password !== "") parsed.password = "***";
    return parsed.toString();
  } catch {
    return "<unparseable DATABASE_URL>";
  }
}

/**
 * Every bound is set explicitly (CLAUDE.md hard rule 7). A migration that hangs
 * on a lock should fail loudly in ten seconds, not wedge a deploy.
 */
export async function connect(url: string, options: ConnectOptions = {}): Promise<Client> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  await client.connect();

  const statementTimeout = options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  await client.query(`set statement_timeout = ${statementTimeout}`);
  await client.query(`set lock_timeout = ${LOCK_TIMEOUT_MS}`);
  await client.query(`set idle_in_transaction_session_timeout = ${IDLE_IN_TRANSACTION_TIMEOUT_MS}`);

  return client;
}
