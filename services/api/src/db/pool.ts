import { Pool } from "pg";

const DEFAULT_URL = "postgres://keel:keel@localhost:5432/keel";

/** Every bound explicit (CLAUDE.md hard rule 7). */
export function createPool(connectionString = process.env.DATABASE_URL ?? DEFAULT_URL): Pool {
  return new Pool({
    connectionString,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    max: 20,
  });
}
