import { SignJWT } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type ActionKeypair,
  type ActionVerifyFailure,
  actionJwks,
  canonicalJson,
  confirmationOf,
  generateActionKeypair,
  hashArguments,
  mintActionToken,
  verifyActionToken,
} from "../src/action-token.js";
import { generateIdentityKeypair, type Keypair, mintIdentityToken } from "../src/helper.js";
import { InMemoryReplayCache } from "../src/verify.js";

/**
 * The action-token attack corpus (doc 02 §2.1, threat-model §T2 and §T9).
 *
 * This is the primary security claim, so every attack the doc names has a test
 * here and each must fail for the *right reason* — a token rejected by accident
 * is not a control.
 */

const AUDIENCE = "https://api.northwind.example";
const ARGS = { customer_id: "cus_1", plan: "pro" };

let keel: ActionKeypair;
let customer: Keypair;
let jwks: { keys: Awaited<ReturnType<typeof actionJwks>>["keys"] };
let identityToken: string;
let replayCache: InMemoryReplayCache;
let approvalCache: InMemoryReplayCache;

const verify = (token: string | undefined, over: Record<string, unknown> = {}) =>
  verifyActionToken(token, {
    jwks,
    audience: AUDIENCE,
    body: ARGS,
    identityToken,
    replayCache,
    approvalCache,
    ...over,
  } as never);

const expectRejected = async (
  token: string | undefined,
  reason: ActionVerifyFailure,
  over: Record<string, unknown> = {},
) => {
  const result = await verify(token, over);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe(reason);
};

beforeEach(async () => {
  keel = await generateActionKeypair("keel-1");
  customer = await generateIdentityKeypair("northwind-1");
  jwks = (await actionJwks(keel)) as never;
  replayCache = new InMemoryReplayCache();
  approvalCache = new InMemoryReplayCache();

  identityToken = (
    await mintIdentityToken(customer, {
      subject: "stf_arun",
      issuer: "https://northwind.example",
      audience: "keel:northwind",
    })
  ).token;
});

const mint = (over: Record<string, unknown> = {}) => {
  const { claims: claimOverrides, ...rest } = over;
  return mintActionToken(keel, {
    identityToken,
    args: ARGS,
    ...rest,
    // Merged last so a partial claims override extends the defaults rather than
    // replacing them — spreading `over` after this would silently drop the
    // audience and every test would fail for the wrong reason.
    claims: {
      subject: "stf_arun",
      audience: AUDIENCE,
      act: "cancelSubscription@1",
      runId: "run_1",
      stepId: "step_1",
      ...(claimOverrides as object),
    },
  } as never);
};

describe("the happy path", () => {
  it("accepts a token bound to this identity, audience and body", async () => {
    const { token } = await mint();

    const result = await verify(token);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action.subject).toBe("stf_arun");
    expect(result.action.act).toBe("cancelSubscription@1");
    expect(result.action.runId).toBe("run_1");
  });

  it("caps the lifetime at 60 seconds however long the caller asks for", async () => {
    const { expiresIn } = await mint({ ttlSeconds: 86_400 });

    // A longer-lived action token is a longer window in which a captured one
    // is useful.
    expect(expiresIn).toBe(60);
  });
});

describe("attack corpus", () => {
  it("rejects a replayed token", async () => {
    const { token } = await mint();

    expect((await verify(token)).ok).toBe(true);
    await expectRejected(token, "replayed");
  });

  it("rejects argument mutation after signing", async () => {
    // The body is edited in flight; the hash no longer matches.
    const { token } = await mint();

    await expectRejected(token, "argument_mismatch", {
      body: { customer_id: "cus_1", plan: "enterprise" },
    });
  });

  it("rejects an added argument, not just a changed one", async () => {
    const { token } = await mint();

    await expectRejected(token, "argument_mismatch", {
      body: { ...ARGS, refund: true },
    });
  });

  it("rejects a removed argument", async () => {
    const { token } = await mint();

    await expectRejected(token, "argument_mismatch", { body: { customer_id: "cus_1" } });
  });

  it("rejects a token minted for a different backend", async () => {
    const { token } = await mint({ claims: { audience: "https://other.example" } });

    await expectRejected(token, "wrong_audience");
  });

  it("rejects cross-user substitution", async () => {
    // A valid token for Arun, paired with Priya's identity. This is the attack
    // the whole `cnf` binding exists for: without it, a compromised control
    // plane could pair any token with any identity.
    const { token } = await mint();

    const priya = (
      await mintIdentityToken(customer, {
        subject: "stf_priya",
        issuer: "https://northwind.example",
        audience: "keel:northwind",
      })
    ).token;

    await expectRejected(token, "confirmation_mismatch", { identityToken: priya });
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      act: "x@1",
      args_sha256: hashArguments(ARGS),
      cnf: confirmationOf(identityToken),
    })
      .setProtectedHeader({ alg: "EdDSA", kid: keel.kid })
      .setIssuer("https://keel.local")
      .setAudience(AUDIENCE)
      .setSubject("stf_arun")
      .setJti("j1")
      .setIssuedAt(now - 300)
      .setExpirationTime(now - 60)
      .sign(keel.privateKey);

    await expectRejected(token, "expired");
  });

  it("rejects approval_ref reuse", async () => {
    // An approval authorises one execution. Reusing the reference would let an
    // approved action run twice, undetectably.
    const first = await mint({ claims: { approvalRef: "apr_1" } });
    expect((await verify(first.token)).ok).toBe(true);

    const second = await mint({ claims: { approvalRef: "apr_1" } });
    await expectRejected(second.token, "approval_reused");
  });

  it("rejects a token signed by someone else", async () => {
    const attacker = await generateActionKeypair("keel-1");
    const { token } = await mintActionToken(attacker, {
      identityToken,
      args: ARGS,
      claims: {
        subject: "stf_arun",
        audience: AUDIENCE,
        act: "cancelSubscription@1",
        runId: "r",
        stepId: "s",
      },
    });

    await expectRejected(token, "bad_signature");
  });

  it("rejects a token for a different tool version when the tool is pinned", async () => {
    const { token } = await mint();

    await expectRejected(token, "wrong_tool", { expectedAct: "cancelSubscription@2" });
  });

  it("refuses to verify without the identity token at all", async () => {
    // Without it there is nothing to chain to, so the token cannot be proven to
    // belong to the user it names.
    const { token } = await mint();

    await expectRejected(token, "missing_identity_token", { identityToken: undefined });
  });

  it("never throws, whatever it is given", async () => {
    for (const junk of ["", "a.b.c", "...", "x".repeat(5000)]) {
      await expect(verify(junk)).resolves.toHaveProperty("ok", false);
    }
  });
});

describe("argument hashing", () => {
  it("is stable across key ordering", () => {
    // Otherwise the verifier and the minter would disagree whenever a JSON
    // library reordered keys, and the failure would look like tampering.
    expect(hashArguments({ a: 1, b: 2 })).toBe(hashArguments({ b: 2, a: 1 }));
  });

  it("is stable for nested objects", () => {
    expect(hashArguments({ o: { x: 1, y: 2 } })).toBe(hashArguments({ o: { y: 2, x: 1 } }));
  });

  it("distinguishes array order, because order is meaningful", () => {
    expect(hashArguments([1, 2])).not.toBe(hashArguments([2, 1]));
  });

  it("distinguishes a missing key from a null one", () => {
    expect(hashArguments({ a: 1 })).not.toBe(hashArguments({ a: 1, b: null }));
  });

  it("produces canonical JSON with sorted keys", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});
