import { randomBytes } from "node:crypto";
import type { VerifiedIdentity } from "./verify.js";

/**
 * Sessions (doc 03 §B3).
 *
 * A session is bound to (project, environment, subject, jti). Binding the jti
 * matters: it ties the session to the specific token that authorised it, so
 * every run can record which identity assertion permitted it — and revoking one
 * assertion does not silently leave a session alive.
 */

export type Session = {
  readonly id: string;
  readonly project_id: string;
  readonly environment_id: string;
  readonly subject: string | null;
  readonly identity_jti: string | null;
  readonly anonymous: boolean;
  readonly acl_tags: readonly string[];
  readonly permissions: readonly string[];
  readonly expires_at: number;
};

export type SessionLimits = {
  readonly max_runs_per_hour: number;
  readonly history: boolean;
  readonly user_scoped_tools: boolean;
};

/**
 * Anonymous sessions are supported and clearly second-class (doc 03 §B2): no
 * history, no user-scoped tools, tighter limits. Stated as data so the
 * difference is enforced rather than remembered.
 */
export const ANONYMOUS_LIMITS: SessionLimits = {
  max_runs_per_hour: 20,
  history: false,
  user_scoped_tools: false,
};

export const IDENTIFIED_LIMITS: SessionLimits = {
  max_runs_per_hour: 200,
  history: true,
  user_scoped_tools: true,
};

export function limitsFor(session: Session): SessionLimits {
  return session.anonymous ? ANONYMOUS_LIMITS : IDENTIFIED_LIMITS;
}

const asStrings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

export function sessionFromIdentity(
  identity: VerifiedIdentity,
  context: { project_id: string; environment_id: string; ttlSeconds?: number },
): Session {
  return {
    id: `sess_${randomBytes(24).toString("base64url")}`,
    project_id: context.project_id,
    environment_id: context.environment_id,
    subject: identity.subject,
    identity_jti: identity.jti,
    anonymous: false,
    // groups become knowledge ACL tags (doc 03 §B2).
    acl_tags: asStrings(identity.claims["groups"]),
    permissions: asStrings(identity.claims["permissions"]),
    expires_at: Math.floor(Date.now() / 1000) + (context.ttlSeconds ?? 3600),
  };
}

export function anonymousSession(context: {
  project_id: string;
  environment_id: string;
  ttlSeconds?: number;
}): Session {
  return {
    id: `sess_${randomBytes(24).toString("base64url")}`,
    project_id: context.project_id,
    environment_id: context.environment_id,
    subject: null,
    identity_jti: null,
    anonymous: true,
    // No claims means no ACL tags: an anonymous session reads public knowledge
    // only, and inheriting tags from nowhere would be the bug that leaks it.
    acl_tags: [],
    permissions: [],
    expires_at: Math.floor(Date.now() / 1000) + (context.ttlSeconds ?? 1800),
  };
}
