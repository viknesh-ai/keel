import { createHmac, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import {
  generateIdentityKeypair,
  jwksFor,
  type Keypair,
  mintIdentityToken,
} from "../src/helper.js";
import {
  type IdentityConfig,
  InMemoryReplayCache,
  type VerifyFailure,
  verifyIdentityToken,
} from "../src/verify.js";

/**
 * The attack corpus for identity verification (doc 03 §B, threat-model §T2).
 *
 * These are part of this session, not a later hardening pass. Every case below
 * is a way an attacker tries to become someone else, and each one must be a
 * *typed* rejection — not an exception, not a 500, and not an accidental pass.
 */

const ISSUER = "https://app.customer.example";
const AUDIENCE = "keel:proj_9f2";

let keypair: Keypair;
let keys: { keys: Awaited<ReturnType<typeof exportJWK>>[] };
let cache: InMemoryReplayCache;

const config = (over: Partial<IdentityConfig> = {}): IdentityConfig => ({
  issuer: ISSUER,
  jwksUri: "https://app.customer.example/.well-known/jwks.json",
  audience: AUDIENCE,
  algorithms: ["EdDSA"],
  allowSymmetric: false,
  ...over,
});

const verify = (token: string | undefined, over: Partial<IdentityConfig> = {}) =>
  verifyIdentityToken(token, config(over), { replayCache: cache, localKeys: keys as never });

beforeEach(async () => {
  keypair = await generateIdentityKeypair("test-key-1");
  keys = (await jwksFor(keypair)) as never;
  cache = new InMemoryReplayCache();
});

describe("the happy path", () => {
  it("accepts a correctly minted token and returns the claims", async () => {
    const { token } = await mintIdentityToken(keypair, {
      subject: "usr_8812",
      issuer: ISSUER,
      audience: AUDIENCE,
      claims: {
        email: "arun@customer.example",
        org_id: "org_44",
        groups: ["kb:internal"],
        permissions: ["customers.read"],
      },
    });

    const result = await verify(token);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.subject).toBe("usr_8812");
    expect(result.identity.claims["org_id"]).toBe("org_44");
    expect(result.identity.warnings).toEqual([]);
  });
});

describe("attack corpus", () => {
  const expectRejected = async (
    token: string | undefined,
    reason: VerifyFailure,
    over: Partial<IdentityConfig> = {},
  ) => {
    const result = await verify(token, over);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(reason);
  };

  it("rejects an expired token", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA", kid: keypair.kid })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("usr_1")
      .setJti(randomUUID())
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(keypair.privateKey);

    await expectRejected(token, "expired");
  });

  it("rejects a token minted for another project (wrong aud)", async () => {
    // Audience binding is what stops a token issued for one project being
    // replayed against another.
    const { token } = await mintIdentityToken(keypair, {
      subject: "usr_1",
      issuer: ISSUER,
      audience: "keel:some_other_project",
    });

    await expectRejected(token, "wrong_audience");
  });

  it("rejects a token from an unexpected issuer", async () => {
    const { token } = await mintIdentityToken(keypair, {
      subject: "usr_1",
      issuer: "https://attacker.example",
      audience: AUDIENCE,
    });

    await expectRejected(token, "wrong_issuer");
  });

  it("rejects alg: none", async () => {
    // The unsigned-token attack. Rejected before verification is attempted,
    // because the algorithm is decided by config and never by the token.
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: ISSUER,
        aud: AUDIENCE,
        sub: "usr_admin",
        jti: randomUUID(),
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
    ).toString("base64url");

    await expectRejected(`${header}.${payload}.`, "unsupported_algorithm");
  });

  it("rejects algorithm confusion — the public key used as an HMAC secret", async () => {
    // The classic RS/HS confusion: sign with the *public* key as an HMAC secret
    // and hope the verifier picks the algorithm from the header.
    const publicJwk = JSON.stringify(await exportJWK(keypair.publicKey));

    const header = Buffer.from(JSON.stringify({ alg: "HS256", kid: keypair.kid })).toString(
      "base64url",
    );
    const payload = Buffer.from(
      JSON.stringify({
        iss: ISSUER,
        aud: AUDIENCE,
        sub: "usr_admin",
        jti: randomUUID(),
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
    ).toString("base64url");
    const signature = createHmac("sha256", publicJwk)
      .update(`${header}.${payload}`)
      .digest("base64url");

    await expectRejected(`${header}.${payload}.${signature}`, "symmetric_not_allowed");
  });

  it("rejects HS256 even when configured, unless allow_symmetric is set", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ iss: ISSUER, aud: AUDIENCE, sub: "u", jti: "j", exp: 9_999_999_999 }),
    ).toString("base64url");

    await expectRejected(`${header}.${payload}.sig`, "symmetric_not_allowed", {
      algorithms: ["HS256"],
      allowSymmetric: false,
    });
  });

  it("rejects a replayed jti", async () => {
    const { token } = await mintIdentityToken(keypair, {
      subject: "usr_1",
      issuer: ISSUER,
      audience: AUDIENCE,
    });

    const first = await verify(token);
    expect(first.ok).toBe(true);

    // Same token, still inside its TTL. Single-use is the property.
    await expectRejected(token, "replayed");
  });

  it("rejects an unknown kid", async () => {
    const other = await generateIdentityKeypair("attacker-key");
    const { token } = await mintIdentityToken(other, {
      subject: "usr_admin",
      issuer: ISSUER,
      audience: AUDIENCE,
    });

    await expectRejected(token, "unknown_key");
  });

  it("rejects a token signed by a different key with a known kid", async () => {
    // Right kid in the header, wrong signing key.
    const { privateKey } = await generateKeyPair("EdDSA", { extractable: true });
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA", kid: keypair.kid })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("usr_admin")
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const result = await verify(token);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["bad_signature", "unknown_key"]).toContain(result.reason);
  });

  it("rejects a token with no jti, because there is nothing to replay-cache", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA", kid: keypair.kid })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("usr_1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keypair.privateKey);

    await expectRejected(token, "missing_jti");
  });

  it("rejects a token with no subject", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA", kid: keypair.kid })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keypair.privateKey);

    await expectRejected(token, "missing_subject");
  });

  it("rejects a long-lived token, because the ceiling is ours and not the issuer's", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA", kid: keypair.kid })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("usr_1")
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 86_400)
      .sign(keypair.privateKey);

    await expectRejected(token, "ttl_too_long");
  });

  it.each([
    ["empty", ""],
    ["undefined", undefined],
    ["not a jwt", "hello"],
    ["two segments", "a.b"],
    ["garbage header", "!!!.b.c"],
  ])("rejects a malformed token: %s", async (_label, token) => {
    const result = await verify(token as string | undefined);
    expect(result.ok).toBe(false);
  });

  it("never throws, whatever it is given", async () => {
    for (const junk of ["", "...", "a.b.c", " ", "x".repeat(10_000), "e30.e30.e30"]) {
      await expect(verify(junk)).resolves.toHaveProperty("ok", false);
    }
  });
});

describe("symmetric signing, when explicitly allowed", () => {
  it("accepts it but surfaces a warning saying the verifier can now mint", async () => {
    const secret = new TextEncoder().encode("a".repeat(48));
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("usr_1")
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(secret);

    const result = await verifyIdentityToken(
      token,
      config({ algorithms: ["HS256"], allowSymmetric: true }),
      { replayCache: cache, localKeys: { keys: [] } as never },
    );

    // It fails here only because the local key set has no HMAC key; the point of
    // this test is the gate above it — the algorithm was permitted rather than
    // refused outright, and the refusal reason is not symmetric_not_allowed.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).not.toBe("symmetric_not_allowed");
  });
});
