import { describe, expect, it } from "vitest";
import {
  ANONYMOUS_LIMITS,
  anonymousSession,
  IDENTIFIED_LIMITS,
  limitsFor,
  sessionFromIdentity,
} from "../src/session.js";
import type { VerifiedIdentity } from "../src/verify.js";

const identity = (claims: Record<string, unknown> = {}): VerifiedIdentity => ({
  subject: "usr_8812",
  jti: "jti_1",
  issuer: "https://app.customer.example",
  audience: "keel:proj_1",
  expiresAt: 9_999_999_999,
  issuedAt: 1,
  claims,
  warnings: [],
});

describe("sessions bind to the identity that authorised them", () => {
  it("records the subject and the jti", () => {
    const session = sessionFromIdentity(identity(), {
      project_id: "proj_1",
      environment_id: "env_1",
    });

    expect(session.subject).toBe("usr_8812");
    expect(session.identity_jti).toBe("jti_1");
    expect(session.anonymous).toBe(false);
  });

  it("maps groups to knowledge ACL tags and permissions across", () => {
    const session = sessionFromIdentity(
      identity({ groups: ["kb:internal", "kb:billing"], permissions: ["customers.read"] }),
      { project_id: "proj_1", environment_id: "env_1" },
    );

    expect(session.acl_tags).toEqual(["kb:internal", "kb:billing"]);
    expect(session.permissions).toEqual(["customers.read"]);
  });

  it("ignores non-string entries rather than trusting the token's shape", () => {
    const session = sessionFromIdentity(identity({ groups: ["ok", 42, null, { a: 1 }] }), {
      project_id: "proj_1",
      environment_id: "env_1",
    });

    expect(session.acl_tags).toEqual(["ok"]);
  });
});

describe("anonymous sessions are second-class, enforced rather than remembered", () => {
  it("carries no subject, no tags and no permissions", () => {
    const session = anonymousSession({ project_id: "proj_1", environment_id: "env_1" });

    expect(session.subject).toBeNull();
    expect(session.identity_jti).toBeNull();
    expect(session.acl_tags).toEqual([]);
    expect(session.permissions).toEqual([]);
  });

  it("gets no history, no user-scoped tools and tighter limits", () => {
    const limits = limitsFor(anonymousSession({ project_id: "p", environment_id: "e" }));

    expect(limits).toEqual(ANONYMOUS_LIMITS);
    expect(limits.history).toBe(false);
    expect(limits.user_scoped_tools).toBe(false);
    expect(limits.max_runs_per_hour).toBeLessThan(IDENTIFIED_LIMITS.max_runs_per_hour);
  });

  it("expires sooner than an identified session", () => {
    const anon = anonymousSession({ project_id: "p", environment_id: "e" });
    const known = sessionFromIdentity(identity(), { project_id: "p", environment_id: "e" });

    expect(anon.expires_at).toBeLessThan(known.expires_at);
  });
});
