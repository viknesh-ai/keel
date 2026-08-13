import { createHash } from "node:crypto";
import { type OrgScope, scopedQuery, scopedQueryOne } from "../../db/scope.js";

export type IdentityConfigRow = {
  id: string;
  org_id: string;
  project_id: string;
  issuer: string;
  jwks_uri: string;
  algorithms: string[];
  audience: string;
  allow_symmetric: boolean;
  created_at: Date;
};

export type EndUserIdentityRow = {
  id: string;
  org_id: string;
  project_id: string;
  subject: string;
  claims_digest: string;
  first_seen_at: Date;
  last_seen_at: Date;
};

export async function upsertIdentityConfig(
  scope: OrgScope,
  input: {
    projectId: string;
    issuer: string;
    jwksUri: string;
    audience: string;
    algorithms?: readonly string[];
    allowSymmetric?: boolean;
  },
): Promise<IdentityConfigRow> {
  const row = await scopedQueryOne<IdentityConfigRow>(
    scope,
    `insert into identity_configs
       (org_id, project_id, issuer, jwks_uri, audience, algorithms, allow_symmetric)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (project_id) do update
       set issuer = excluded.issuer,
           jwks_uri = excluded.jwks_uri,
           audience = excluded.audience,
           algorithms = excluded.algorithms,
           allow_symmetric = excluded.allow_symmetric
     returning *`,
    [
      scope.orgId,
      input.projectId,
      input.issuer,
      input.jwksUri,
      input.audience,
      input.algorithms ?? ["EdDSA", "RS256", "ES256"],
      input.allowSymmetric ?? false,
    ],
  );
  if (row === undefined) throw new Error("upsertIdentityConfig returned no row");
  return row;
}

export async function getIdentityConfig(
  scope: OrgScope,
  projectId: string,
): Promise<IdentityConfigRow | undefined> {
  return scopedQueryOne<IdentityConfigRow>(
    scope,
    "select * from identity_configs where project_id = $1",
    [projectId],
  );
}

export async function deleteIdentityConfig(scope: OrgScope, projectId: string): Promise<boolean> {
  const rows = await scopedQuery(
    scope,
    "delete from identity_configs where project_id = $1 returning id",
    [projectId],
  );
  return rows.length === 1;
}

/**
 * A digest over the claim set, never the claims themselves (doc 04 §B1).
 *
 * Keys are sorted so the same claims produce the same digest regardless of the
 * IdP's serialisation order; otherwise the digest would correlate nothing.
 */
export function digestClaims(claims: Record<string, unknown>): string {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(claims).sort(([a], [b]) => a.localeCompare(b))),
  );
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** First sighting inserts; every later one only moves last_seen_at. */
export async function recordIdentity(
  scope: OrgScope,
  input: { projectId: string; subject: string; claims: Record<string, unknown> },
): Promise<EndUserIdentityRow> {
  const row = await scopedQueryOne<EndUserIdentityRow>(
    scope,
    `insert into end_user_identities (org_id, project_id, subject, claims_digest)
     values ($1, $2, $3, $4)
     on conflict (project_id, subject) do update
       set last_seen_at = now(), claims_digest = excluded.claims_digest
     returning *`,
    [scope.orgId, input.projectId, input.subject, digestClaims(input.claims)],
  );
  if (row === undefined) throw new Error("recordIdentity returned no row");
  return row;
}

export async function getIdentity(
  scope: OrgScope,
  projectId: string,
  subject: string,
): Promise<EndUserIdentityRow | undefined> {
  return scopedQueryOne<EndUserIdentityRow>(
    scope,
    "select * from end_user_identities where project_id = $1 and subject = $2",
    [projectId, subject],
  );
}
