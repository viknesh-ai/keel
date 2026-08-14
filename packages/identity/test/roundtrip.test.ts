import { describe, expect, it } from "vitest";
import { generateIdentityKeypair, jwksFor, mintIdentityToken } from "../src/helper.js";
import { InMemoryReplayCache, verifyIdentityToken } from "../src/verify.js";

/**
 * The session's exit criterion: demo-saas mints tokens the platform accepts.
 *
 * Asserted here against the same helper apps/demo-saas now uses, so "the
 * customer's integration and our verifier agree" is a test rather than a claim.
 */
describe("keel-identity mints what the platform accepts", () => {
  it("round-trips a token with the claims the policy engine reads", async () => {
    const keypair = await generateIdentityKeypair("northwind-demo-1");
    const keys = await jwksFor(keypair);

    const { token } = await mintIdentityToken(keypair, {
      subject: "stf_1",
      issuer: "https://northwind.example",
      audience: "keel:northwind",
      claims: {
        permissions: ["customers.read", "subscriptions.write"],
        groups: ["kb:public"],
        org_id: "org_northwind",
      },
    });

    const result = await verifyIdentityToken(
      token,
      {
        issuer: "https://northwind.example",
        jwksUri: "https://northwind.example/.well-known/jwks.json",
        audience: "keel:northwind",
        algorithms: ["EdDSA"],
        allowSymmetric: false,
      },
      { replayCache: new InMemoryReplayCache(), localKeys: keys as never },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.subject).toBe("stf_1");
    expect(result.identity.claims["permissions"]).toEqual([
      "customers.read",
      "subscriptions.write",
    ]);
    expect(result.identity.warnings).toEqual([]);
  });

  it("caps the TTL at mint time, so a caller cannot issue a token we would reject", async () => {
    const keypair = await generateIdentityKeypair();

    const { expiresIn } = await mintIdentityToken(keypair, {
      subject: "s",
      issuer: "https://i.example",
      audience: "a",
      ttlSeconds: 86_400,
    });

    expect(expiresIn).toBe(600);
  });

  it("gives every token a distinct jti, so replay protection has something to key on", async () => {
    const keypair = await generateIdentityKeypair();
    const opts = { subject: "s", issuer: "https://i.example", audience: "a" };

    const a = await mintIdentityToken(keypair, opts);
    const b = await mintIdentityToken(keypair, opts);

    expect(a.jti).not.toBe(b.jti);
  });
});
