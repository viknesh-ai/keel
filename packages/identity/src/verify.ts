import { createLocalJWKSet, createRemoteJWKSet, type JWK, type JWTPayload, jwtVerify } from "jose";

/**
 * End-user identity verification (doc 03 §B, threat-model §T2).
 *
 * The principle, from which everything else follows: **a user identifier
 * supplied by a client is not an identity.** There is no `userId` parameter
 * anywhere in this package. The only accepted proof is a token signed by the
 * customer's own key, verified against their JWKS.
 *
 * Asymmetric by default, and that asymmetry is the primary security claim: a
 * verifier can check a token but cannot mint one, so a compromised control
 * plane still cannot fabricate a user. A shared symmetric secret gives that
 * away — which is the specific weakness in the trusted-header pattern this is
 * designed against.
 */

export type IdentityConfig = {
  readonly issuer: string;
  readonly jwksUri: string;
  readonly audience: string;
  readonly algorithms: readonly string[];
  /**
   * HS* is accepted only when this is explicitly true, and the caller is told.
   * Symmetric signing means the verifier can mint.
   */
  readonly allowSymmetric: boolean;
  /** Hard ceiling regardless of what the token claims. Doc 03 §B2: ≤ 10 minutes. */
  readonly maxTtlSeconds?: number;
};

export type VerifiedIdentity = {
  readonly subject: string;
  readonly jti: string;
  readonly issuer: string;
  readonly audience: string;
  readonly expiresAt: number;
  readonly issuedAt: number;
  readonly claims: Readonly<Record<string, unknown>>;
  /** Non-fatal notes the dashboard surfaces — currently only symmetric signing. */
  readonly warnings: readonly string[];
};

export type VerifyFailure =
  | "missing_token"
  | "malformed"
  | "unsupported_algorithm"
  | "symmetric_not_allowed"
  | "unknown_key"
  | "bad_signature"
  | "expired"
  | "not_yet_valid"
  | "wrong_audience"
  | "wrong_issuer"
  | "missing_jti"
  | "missing_subject"
  | "ttl_too_long"
  | "replayed";

export type VerifyResult =
  | { readonly ok: true; readonly identity: VerifiedIdentity }
  | { readonly ok: false; readonly reason: VerifyFailure; readonly detail: string };

export const MAX_TTL_SECONDS = 600;

/** Asymmetric only. HS* is deliberately absent and gated separately. */
const ASYMMETRIC = new Set([
  "EdDSA",
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
  "ES512",
  "PS256",
]);
const SYMMETRIC = new Set(["HS256", "HS384", "HS512"]);

/**
 * Replay cache for `jti`. Redis in production; the interface is here so this
 * package stays free of a Redis dependency and can be tested in memory.
 *
 * `add` returns false when the jti has been seen. Single-use is the property —
 * a captured token must not be usable twice even inside its TTL.
 */
export interface ReplayCache {
  add(jti: string, expiresAtSeconds: number): Promise<boolean>;
}

export class InMemoryReplayCache implements ReplayCache {
  readonly #seen = new Map<string, number>();

  async add(jti: string, expiresAtSeconds: number): Promise<boolean> {
    const now = Date.now() / 1000;
    for (const [key, expiry] of this.#seen) {
      if (expiry <= now) this.#seen.delete(key);
    }
    if (this.#seen.has(jti)) return false;
    this.#seen.set(jti, expiresAtSeconds);
    return true;
  }
}

type KeyResolver = ReturnType<typeof createRemoteJWKSet> | ReturnType<typeof createLocalJWKSet>;

/**
 * Caches one key resolver per JWKS URI.
 *
 * jose's remote set handles rotation and cooldown itself: an unknown `kid`
 * triggers at most one refetch within the cooldown, so a rotated key is picked
 * up without turning every unknown kid into an outbound request — which would
 * otherwise be a free amplification primitive for anyone sending junk tokens.
 */
const resolvers = new Map<string, KeyResolver>();

export function resolverFor(config: IdentityConfig, localKeys?: { keys: JWK[] }): KeyResolver {
  if (localKeys !== undefined) return createLocalJWKSet(localKeys);

  const existing = resolvers.get(config.jwksUri);
  if (existing !== undefined) return existing;

  const created = createRemoteJWKSet(new URL(config.jwksUri), {
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
    timeoutDuration: 5_000,
  });
  resolvers.set(config.jwksUri, created);
  return created;
}

/** Exposed for tests; a rotated key should not need a process restart. */
export function clearResolverCache(): void {
  resolvers.clear();
}

function algorithmOf(token: string): string | undefined {
  const [header] = token.split(".");
  if (header === undefined) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as {
      alg?: unknown;
    };
    return typeof decoded.alg === "string" ? decoded.alg : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Verify an end-user identity token.
 *
 * Returns a typed failure rather than throwing, and the reason is deliberately
 * coarse at the boundary: the caller maps every one of these to the same 401 so
 * an attacker cannot distinguish "expired" from "bad signature" and learn which
 * half of their guess was right.
 */
export async function verifyIdentityToken(
  token: string | undefined,
  config: IdentityConfig,
  options: { readonly replayCache?: ReplayCache; readonly localKeys?: { keys: JWK[] } } = {},
): Promise<VerifyResult> {
  if (token === undefined || token.trim() === "") {
    return { ok: false, reason: "missing_token", detail: "no token supplied" };
  }

  const alg = algorithmOf(token);
  if (alg === undefined) {
    return { ok: false, reason: "malformed", detail: "token header is not readable" };
  }

  // `alg: none` and anything not on the list are rejected before verification
  // is attempted. Deciding the algorithm from the token's own header is the
  // classic confusion attack; the config decides, not the token.
  if (SYMMETRIC.has(alg)) {
    if (!config.allowSymmetric) {
      return {
        ok: false,
        reason: "symmetric_not_allowed",
        detail: `${alg} requires allow_symmetric, because a shared secret means the verifier can mint tokens`,
      };
    }
  } else if (!ASYMMETRIC.has(alg)) {
    return {
      ok: false,
      reason: "unsupported_algorithm",
      detail: `algorithm ${alg} is not accepted`,
    };
  }

  if (!config.algorithms.includes(alg)) {
    return {
      ok: false,
      reason: "unsupported_algorithm",
      detail: `algorithm ${alg} is not configured for this project`,
    };
  }

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, resolverFor(config, options.localKeys), {
      issuer: config.issuer,
      audience: config.audience,
      // Passed explicitly so jose refuses anything else even if the header says so.
      algorithms: [...config.algorithms],
      clockTolerance: 5,
    });
    payload = verified.payload;
  } catch (cause) {
    const { code = "", claim = "" } = cause as { code?: string; claim?: string };
    const message = cause instanceof Error ? cause.message : String(cause);

    if (code === "ERR_JWT_EXPIRED") return { ok: false, reason: "expired", detail: message };
    if (code === "ERR_JWKS_NO_MATCHING_KEY") {
      return { ok: false, reason: "unknown_key", detail: message };
    }

    // jose reports which claim failed on the error itself. Matching that rather
    // than the message text: the message says `unexpected "aud" claim value`,
    // so grepping for "audience" silently misclassifies every audience failure
    // — which is how a wrong-project token gets reported as a clock problem.
    if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
      if (claim === "aud") return { ok: false, reason: "wrong_audience", detail: message };
      if (claim === "iss") return { ok: false, reason: "wrong_issuer", detail: message };
      return { ok: false, reason: "not_yet_valid", detail: message };
    }

    return { ok: false, reason: "bad_signature", detail: message };
  }

  const { sub, jti, exp, iat } = payload;

  if (typeof sub !== "string" || sub === "") {
    return { ok: false, reason: "missing_subject", detail: "sub is required" };
  }
  // Without a jti there is nothing to replay-cache, so a token without one is
  // rejected rather than accepted-and-unprotected.
  if (typeof jti !== "string" || jti === "") {
    return { ok: false, reason: "missing_jti", detail: "jti is required for replay protection" };
  }
  if (typeof exp !== "number") {
    return { ok: false, reason: "malformed", detail: "exp is required" };
  }

  const maxTtl = config.maxTtlSeconds ?? MAX_TTL_SECONDS;
  const issued = typeof iat === "number" ? iat : exp - maxTtl;
  if (exp - issued > maxTtl + 5) {
    // A long-lived identity token is a long-lived compromise. The ceiling is
    // ours, not the issuer's, so a customer misconfiguring their IdP cannot
    // widen it.
    return {
      ok: false,
      reason: "ttl_too_long",
      detail: `token lifetime ${exp - issued}s exceeds the ${maxTtl}s maximum`,
    };
  }

  if (options.replayCache !== undefined) {
    const fresh = await options.replayCache.add(jti, exp);
    if (!fresh) {
      return { ok: false, reason: "replayed", detail: "this token has already been used" };
    }
  }

  const warnings = SYMMETRIC.has(alg)
    ? [
        "This project accepts symmetric signing. The verifier can mint tokens, which removes the guarantee that a compromised control plane cannot impersonate a user. Move to EdDSA or RS256.",
      ]
    : [];

  return {
    ok: true,
    identity: {
      subject: sub,
      jti,
      issuer: config.issuer,
      audience: config.audience,
      expiresAt: exp,
      issuedAt: issued,
      claims: payload as Record<string, unknown>,
      warnings,
    },
  };
}
