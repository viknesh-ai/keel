import {
  actionJwks,
  generateActionKeypair,
  generateIdentityKeypair,
  mintActionToken,
  mintIdentityToken,
} from "@keel/identity";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createVerifier, keelFastifyVerifier, keelVerifier } from "../src/verify-middleware.js";

/**
 * The middleware a customer actually mounts.
 *
 * Every rejection is a 401 with no detail: distinguishing "expired" from "bad
 * signature" tells an attacker which half of their guess was right.
 */

const AUDIENCE = "https://api.northwind.example";
const BODY = { customer_id: "cus_1" };

let jwks: { keys: never[] };
let identityToken: string;
let token: string;

beforeEach(async () => {
  const keel = await generateActionKeypair("keel-1");
  const customer = await generateIdentityKeypair("nw-1");
  jwks = (await actionJwks(keel)) as never;

  identityToken = (
    await mintIdentityToken(customer, {
      subject: "stf_1",
      issuer: "https://northwind.example",
      audience: "keel:northwind",
    })
  ).token;

  token = (
    await mintActionToken(keel, {
      identityToken,
      args: BODY,
      claims: {
        subject: "stf_1",
        audience: AUDIENCE,
        act: "getCustomer@1",
        runId: "r",
        stepId: "s",
      },
    })
  ).token;
});

const headers = (over: Record<string, string | undefined> = {}) => ({
  authorization: `Bearer ${token}`,
  "keel-identity": identityToken,
  ...over,
});

describe("createVerifier", () => {
  it("accepts a well-formed request and returns the acting subject", async () => {
    const verify = createVerifier({ jwks, audience: AUDIENCE });

    const result = await verify({ headers: headers(), body: BODY });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action.subject).toBe("stf_1");
  });

  it("rejects a request whose body was edited after signing", async () => {
    const verify = createVerifier({ jwks, audience: AUDIENCE });

    const result = await verify({ headers: headers(), body: { customer_id: "cus_2" } });

    expect(result.ok).toBe(false);
  });

  it("reads the header case-insensitively", async () => {
    const verify = createVerifier({ jwks, audience: AUDIENCE });

    const result = await verify({
      headers: { Authorization: `Bearer ${token}`, "Keel-Identity": identityToken },
      body: BODY,
    });

    expect(result.ok).toBe(true);
  });
});

describe("the Express adapter", () => {
  it("passes a valid request through and attaches the action", async () => {
    const middleware = keelVerifier({ jwks, audience: AUDIENCE });
    const req = { headers: headers(), body: BODY } as never as { keel?: unknown };
    const next = vi.fn();
    const res = { status: vi.fn(() => ({ json: vi.fn() })) };

    await middleware(req as never, res as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect((req as { keel?: { subject: string } }).keel?.subject).toBe("stf_1");
  });

  it("answers 401 with no detail, whatever the reason", async () => {
    const middleware = keelVerifier({ jwks, audience: AUDIENCE });
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) };
    const next = vi.fn();

    await middleware(
      { headers: { authorization: "Bearer nonsense" }, body: {} } as never,
      res as never,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "unauthorized" });
    expect(next).not.toHaveBeenCalled();
  });
});

describe("the Fastify adapter", () => {
  it("passes a valid request through", async () => {
    const hook = keelFastifyVerifier({ jwks, audience: AUDIENCE });
    const request = { headers: headers(), body: BODY } as never as { keel?: unknown };
    const send = vi.fn();
    const reply = { code: vi.fn(() => ({ send })) };

    await hook(request as never, reply as never);

    expect(reply.code).not.toHaveBeenCalled();
    expect((request as { keel?: { subject: string } }).keel?.subject).toBe("stf_1");
  });

  it("answers 401 on a replay", async () => {
    const hook = keelFastifyVerifier({ jwks, audience: AUDIENCE });
    const send = vi.fn();
    const reply = { code: vi.fn(() => ({ send })) };

    await hook({ headers: headers(), body: BODY } as never, reply as never);
    await hook({ headers: headers(), body: BODY } as never, reply as never);

    expect(reply.code).toHaveBeenCalledWith(401);
  });
});
