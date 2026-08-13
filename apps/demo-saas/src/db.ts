import { Pool } from "pg";
import { config } from "./config.js";

/**
 * One pool for the process. Every statement is parameterised — Northwind is the
 * app the security suite attacks, so it has to be worth attacking, not trivially
 * broken.
 */
export const pool = new Pool({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: 10_000,
  max: 10,
});

export async function query<T extends Record<string, unknown>>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(sql, [...params]);
  return result.rows;
}

export async function queryOne<T extends Record<string, unknown>>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T | undefined> {
  const rows = await query<T>(sql, params);
  return rows[0];
}
