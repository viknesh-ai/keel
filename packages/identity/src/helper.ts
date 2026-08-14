import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, type JWK, type KeyLike, SignJWT } from "jose";

/**
 * `keel-identity` for Node (doc 03 §B2).
 *
 * The five-minute integration has to stay five minutes, or the security model
 * does not get adopted and people fall back to a shared secret. So this is
 * deliberately three functions: make a keypair, serve a JWKS, mint a token.
 *
 * The minting side enforces the same ceilings the verifier does, so a customer
 * cannot accidentally issue a token their own platform will reject.
 */

export const DEFAULT_TTL_SECONDS = 600;

export type Keypair = {
  readonly privateKey: KeyLike;
  readonly publicKey: KeyLike;
  readonly kid: string;
};

export async function generateIdentityKeypair(kid: string = randomUUID()): Promise<Keypair> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  return { privateKey, publicKey, kid };
}

/** The JWKS a customer serves. Public material only — there is nothing secret here. */
export async function jwksFor(keypair: Keypair): Promise<{ keys: JWK[] }> {
  const jwk = await exportJWK(keypair.publicKey);
  return { keys: [{ ...jwk, kid: keypair.kid, use: "sig", alg: "EdDSA" }] };
}

export type MintOptions = {
  readonly subject: string;
  readonly issuer: string;
  readonly audience: string;
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly ttlSeconds?: number;
};

export async function mintIdentityToken(
  keypair: Keypair,
  options: MintOptions,
): Promise<{ token: string; jti: string; expiresIn: number }> {
  const ttl = Math.min(options.ttlSeconds ?? DEFAULT_TTL_SECONDS, DEFAULT_TTL_SECONDS);
  const jti = randomUUID();

  const token = await new SignJWT({ ...(options.claims ?? {}) })
    .setProtectedHeader({ alg: "EdDSA", kid: keypair.kid })
    .setIssuer(options.issuer)
    .setAudience(options.audience)
    .setSubject(options.subject)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(keypair.privateKey);

  return { token, jti, expiresIn: ttl };
}
