import { createHash, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, type JWK, jwtVerify, type KeyLike, SignJWT } from "jose";
import type { ReplayCache } from "./verify.js";

/**
 * Action tokens (doc 02 §2.1, threat-model §T2 and §T9).
 *
 * This is the primary security claim, so it is worth stating what it replaces.
 * The pattern this exists to beat is: a service key proves *a trusted service is
 * calling*, and a `X-User-ID` header is then believed. That is one compromised
 * hop away from total cross-user access, and the customer's backend has no way
 * to tell.
 *
 * Instead the customer's backend receives a token that is
 *
 *   - **chained** to the identity token their own IdP minted (`cnf`), so no
 *     valid token can be produced for a user we never received an assertion
 *     for; and
 *   - **bound to one call** by audience, tool version and a hash of the exact
 *     arguments, so a captured token cannot be pointed at a different operation
 *     or replayed with different values.
 *
 * Every field below exists to close a specific attack. None is decorative.
 */

export const ACTION_TOKEN_TTL_SECONDS = 60;

export type ActionTokenClaims = {
  /** From the *verified* identity token. Never from a request parameter. */
  readonly subject: string;
  /** The tool's declared audience — binds the token to one backend. */
  readonly audience: string;
  /** `tool@version`, so a token for v1 cannot call v2. */
  readonly act: string;
  readonly runId: string;
  readonly stepId: string;
  /** Present when a human approved this specific call. Single-use. */
  readonly approvalRef?: string;
};

export type ActionKeypair = {
  readonly privateKey: KeyLike;
  readonly publicKey: KeyLike;
  readonly kid: string;
};

export async function generateActionKeypair(kid = `keel-${randomUUID()}`): Promise<ActionKeypair> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  return { privateKey, publicKey, kid };
}

/** Keel's public JWKS. The customer's backend verifies against this. */
export async function actionJwks(keypair: ActionKeypair): Promise<{ keys: JWK[] }> {
  const jwk = await exportJWK(keypair.publicKey);
  return { keys: [{ ...jwk, kid: keypair.kid, use: "sig", alg: "EdDSA" }] };
}

/**
 * Canonical JSON for hashing arguments.
 *
 * Key order must not change the hash, or the verifier and the minter would
 * disagree whenever a JSON library reordered keys — and the failure would look
 * like tampering. Sorting is what makes `args_sha256` a usable binding rather
 * than a source of false alarms.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function hashArguments(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args), "utf8").digest("hex");
}

/** `cnf` — the confirmation binding to the identity token that authorised this. */
export function confirmationOf(identityToken: string): string {
  return createHash("sha256").update(identityToken, "utf8").digest("hex");
}

export async function mintActionToken(
  keypair: ActionKeypair,
  input: {
    readonly identityToken: string;
    readonly claims: ActionTokenClaims;
    readonly args: unknown;
    readonly issuer?: string;
    readonly ttlSeconds?: number;
  },
): Promise<{ token: string; jti: string; args_sha256: string; expiresIn: number }> {
  const jti = randomUUID();
  const argsHash = hashArguments(input.args);
  // Capped, never widened: a longer-lived action token is a longer window in
  // which a captured one is useful.
  const ttl = Math.min(input.ttlSeconds ?? ACTION_TOKEN_TTL_SECONDS, ACTION_TOKEN_TTL_SECONDS);

  const token = await new SignJWT({
    act: input.claims.act,
    args_sha256: argsHash,
    run_id: input.claims.runId,
    step_id: input.claims.stepId,
    cnf: confirmationOf(input.identityToken),
    ...(input.claims.approvalRef === undefined ? {} : { approval_ref: input.claims.approvalRef }),
  })
    .setProtectedHeader({ alg: "EdDSA", kid: keypair.kid })
    .setIssuer(input.issuer ?? "https://keel.local")
    .setAudience(input.claims.audience)
    .setSubject(input.claims.subject)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(keypair.privateKey);

  return { token, jti, args_sha256: argsHash, expiresIn: ttl };
}

/* -------------------------------------------------------------- verifying -- */

export type ActionVerifyFailure =
  | "missing_action_token"
  | "missing_identity_token"
  | "malformed"
  | "bad_signature"
  | "expired"
  | "wrong_audience"
  | "wrong_issuer"
  | "confirmation_mismatch"
  | "argument_mismatch"
  | "wrong_tool"
  | "replayed"
  | "approval_reused";

export type VerifiedAction = {
  readonly subject: string;
  readonly act: string;
  readonly runId: string;
  readonly stepId: string;
  readonly approvalRef: string | null;
  readonly jti: string;
};

export type ActionVerifyResult =
  | { readonly ok: true; readonly action: VerifiedAction }
  | { readonly ok: false; readonly reason: ActionVerifyFailure; readonly detail: string };

export type ActionVerifyOptions = {
  /** Keel's public keys. A local set in tests, a fetched JWKS in production. */
  readonly jwks: { keys: JWK[] } | ((protectedHeader: unknown) => Promise<KeyLike>);
  readonly audience: string;
  readonly issuer?: string;
  /** The request body, as received. Hashed and compared to args_sha256. */
  readonly body: unknown;
  /** The identity token from the Keel-Identity header. */
  readonly identityToken: string | undefined;
  /** Rejects a jti that has already been used. */
  readonly replayCache?: ReplayCache;
  /** Rejects an approval_ref that has already been consumed. Single-use. */
  readonly approvalCache?: ReplayCache;
  /** Optional: require the token to be for this exact `tool@version`. */
  readonly expectedAct?: string;
};

/**
 * The five checks from doc 02 §2.1, in order, all mandatory.
 *
 * Skipping any one of them collapses the guarantee:
 *
 *   1. signature — otherwise anyone mints
 *   2. audience  — otherwise a token for backend A works on backend B
 *   3. cnf       — otherwise a valid token can be paired with a different user's
 *                  identity, which is the cross-user substitution attack
 *   4. args hash — otherwise the body can be edited after signing
 *   5. jti       — otherwise it replays until expiry
 */
export async function verifyActionToken(
  token: string | undefined,
  options: ActionVerifyOptions,
): Promise<ActionVerifyResult> {
  if (token === undefined || token.trim() === "") {
    return { ok: false, reason: "missing_action_token", detail: "no action token supplied" };
  }
  if (options.identityToken === undefined || options.identityToken.trim() === "") {
    // Without the identity token there is nothing to chain to, so the token
    // cannot be proven to belong to the user it names.
    return {
      ok: false,
      reason: "missing_identity_token",
      detail: "the Keel-Identity header is required",
    };
  }

  const { createLocalJWKSet } = await import("jose");
  const resolver =
    typeof options.jwks === "function" ? options.jwks : createLocalJWKSet(options.jwks);

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, resolver as never, {
      audience: options.audience,
      ...(options.issuer === undefined ? {} : { issuer: options.issuer }),
      algorithms: ["EdDSA"],
      clockTolerance: 5,
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (cause) {
    const { code = "", claim = "" } = cause as { code?: string; claim?: string };
    const detail = cause instanceof Error ? cause.message : String(cause);

    if (code === "ERR_JWT_EXPIRED") return { ok: false, reason: "expired", detail };
    if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
      if (claim === "aud") return { ok: false, reason: "wrong_audience", detail };
      if (claim === "iss") return { ok: false, reason: "wrong_issuer", detail };
    }
    return { ok: false, reason: "bad_signature", detail };
  }

  const { sub, jti, act, cnf, args_sha256, run_id, step_id, approval_ref } = payload;

  if (typeof sub !== "string" || typeof jti !== "string" || typeof act !== "string") {
    return { ok: false, reason: "malformed", detail: "sub, jti and act are required" };
  }

  // 3. The chain. This is the check that makes cross-user substitution
  // impossible: pairing a valid action token with someone else's identity
  // fails here, because cnf was computed over the identity we were given.
  if (cnf !== confirmationOf(options.identityToken)) {
    return {
      ok: false,
      reason: "confirmation_mismatch",
      detail: "the action token was not issued against this identity token",
    };
  }

  // 4. The arguments. Editing the body after signing changes the hash.
  if (args_sha256 !== hashArguments(options.body)) {
    return {
      ok: false,
      reason: "argument_mismatch",
      detail: "the request body does not match the arguments this token was issued for",
    };
  }

  if (options.expectedAct !== undefined && act !== options.expectedAct) {
    return {
      ok: false,
      reason: "wrong_tool",
      detail: `this token authorises ${act}, not ${options.expectedAct}`,
    };
  }

  // 5. Single use.
  if (options.replayCache !== undefined) {
    const exp = typeof payload["exp"] === "number" ? payload["exp"] : 0;
    if (!(await options.replayCache.add(jti, exp))) {
      return { ok: false, reason: "replayed", detail: "this action token has already been used" };
    }
  }

  // An approval authorises one execution. Reusing the reference would let an
  // approved action run twice — undetectably, in the pattern this replaces.
  if (typeof approval_ref === "string" && options.approvalCache !== undefined) {
    const exp = typeof payload["exp"] === "number" ? payload["exp"] : 0;
    if (!(await options.approvalCache.add(approval_ref, exp + 3600))) {
      return {
        ok: false,
        reason: "approval_reused",
        detail: "this approval has already been consumed",
      };
    }
  }

  return {
    ok: true,
    action: {
      subject: sub,
      act,
      runId: typeof run_id === "string" ? run_id : "",
      stepId: typeof step_id === "string" ? step_id : "",
      approvalRef: typeof approval_ref === "string" ? approval_ref : null,
      jti,
    },
  };
}
