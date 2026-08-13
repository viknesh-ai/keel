import type { Pool, PoolClient } from "pg";

/**
 * Org scoping, enforced at the type level and at the database at once.
 *
 * CLAUDE.md hard rule 3 says every tenant query filters org_id, with RLS as
 * defence in depth. Both halves of that are easy to state and easy to forget,
 * so this makes forgetting unrepresentable:
 *
 *   - `OrgScope` carries a unique symbol, so it cannot be constructed by a
 *     caller writing `{ orgId, client }`. The only way to obtain one is
 *     `withOrgScope`, which means a repository function that takes an OrgScope
 *     cannot be called at all without going through it.
 *   - `withOrgScope` opens a transaction and sets `keel.org_id` on it, so the
 *     RLS policies from 0001-0004 are already active on every statement the
 *     scope runs. The type guarantee and the runtime guarantee are the same
 *     object; they cannot drift apart.
 *
 * A repository method that took `orgId: string` instead would compile fine when
 * someone passed the wrong tenant's id, and would run outside RLS. That is the
 * failure this shape removes.
 */

declare const orgScopeBrand: unique symbol;

export type OrgScope = {
  readonly [orgScopeBrand]: true;
  readonly orgId: string;
  /** The transaction with keel.org_id set. Repositories query through this. */
  readonly client: PoolClient;
};

export type ActorScope = OrgScope & {
  /** The acting dashboard user, for the tables keyed on keel.user_id. */
  readonly userId: string;
};

/**
 * Runs `fn` inside a transaction scoped to one organization.
 *
 * `set_config(..., true)` makes the setting local to the transaction, so it is
 * discarded on commit or rollback. A pooled connection therefore cannot leak
 * one request's tenant into the next — which is the bug this shape exists to
 * make impossible, and the reason the setting is not session-wide.
 */
export async function withOrgScope<T>(
  pool: Pool,
  orgId: string,
  fn: (scope: OrgScope) => Promise<T>,
): Promise<T> {
  if (orgId === "") throw new Error("withOrgScope requires a non-empty org id");

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('keel.org_id', $1, true)", [orgId]);

    const scope = { orgId, client } as unknown as OrgScope;
    const result = await fn(scope);

    await client.query("commit");
    return result;
  } catch (cause) {
    await client.query("rollback").catch(() => undefined);
    throw cause;
  } finally {
    client.release();
  }
}

/** As `withOrgScope`, and additionally sets keel.user_id for the `users` table. */
export async function withActorScope<T>(
  pool: Pool,
  orgId: string,
  userId: string,
  fn: (scope: ActorScope) => Promise<T>,
): Promise<T> {
  if (userId === "") throw new Error("withActorScope requires a non-empty user id");

  return withOrgScope(pool, orgId, async (scope) => {
    await scope.client.query("select set_config('keel.user_id', $1, true)", [userId]);
    return fn({ ...scope, userId } as ActorScope);
  });
}

/**
 * Query helper. Every repository goes through this rather than touching the
 * client directly, so there is one place where the scope's transaction is used
 * and no way to accidentally reach a different connection.
 */
export async function scopedQuery<T extends Record<string, unknown>>(
  scope: OrgScope,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await scope.client.query<T>(sql, [...params]);
  return result.rows;
}

export async function scopedQueryOne<T extends Record<string, unknown>>(
  scope: OrgScope,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T | undefined> {
  const rows = await scopedQuery<T>(scope, sql, params);
  return rows[0];
}
