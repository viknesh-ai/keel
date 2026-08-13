import type { Client } from "pg";
import { setSessionOrg, setSessionUser } from "./database.js";

export type SeededOrg = {
  readonly orgId: string;
  readonly userId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly apiKeyId: string;
  readonly apiKeyHash: string;
};

async function scalar(client: Client, sql: string, params: unknown[] = []): Promise<string> {
  const result = await client.query<{ id: string }>(sql, params);
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error(`expected one row from: ${sql}`);
  return id;
}

/**
 * Seeds one complete tenant.
 *
 * Must be given an *app-role* connection, not an admin one. The database
 * superuser bypasses RLS even with FORCE set, so seeding as admin would skip
 * every WITH CHECK clause and the fixture would prove nothing. Seeding through
 * the unprivileged role means the write-side predicates are exercised for real,
 * which is why this has to set keel.org_id and keel.user_id before each insert.
 */
export async function seedOrg(
  client: Client,
  options: { slug: string; email: string },
): Promise<SeededOrg> {
  const orgId = await scalar(client, "select keel_id('org') as id");
  const userId = await scalar(client, "select keel_id('usr') as id");

  await setSessionOrg(client, orgId);
  await setSessionUser(client, userId);

  await client.query("insert into organizations (id, name, slug) values ($1, $2, $3)", [
    orgId,
    `Org ${options.slug}`,
    options.slug,
  ]);
  await client.query(
    "insert into users (id, email, name, auth_provider) values ($1, $2, $3, 'password')",
    [userId, options.email, `User ${options.slug}`],
  );
  await client.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [
    orgId,
    userId,
  ]);

  const projectId = await scalar(
    client,
    "insert into projects (org_id, name, slug) values ($1, $2, $3) returning id",
    [orgId, `Project ${options.slug}`, `project-${options.slug}`],
  );
  const environmentId = await scalar(
    client,
    `insert into environments (org_id, project_id, name)
     values ($1, $2, 'production') returning id`,
    [orgId, projectId],
  );

  // A hash, never a key. The CHECK constraint on api_keys.hash enforces it.
  const apiKeyHash = await scalar(client, "select encode(sha256($1::bytea), 'hex') as id", [
    `key-for-${options.slug}`,
  ]);
  const apiKeyId = await scalar(
    client,
    `insert into api_keys (org_id, project_id, name, hash, scopes)
     values ($1, $2, $3, $4, '{"runs:read"}') returning id`,
    [orgId, projectId, `Key ${options.slug}`, apiKeyHash],
  );

  await setSessionOrg(client, null);
  await setSessionUser(client, null);

  return { orgId, userId, projectId, environmentId, apiKeyId, apiKeyHash };
}
