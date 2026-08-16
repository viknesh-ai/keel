import {
  type ActionVerifyResult,
  InMemoryReplayCache,
  type ReplayCache,
  verifyActionToken,
} from "@keel/identity";
import type { JWK } from "jose";

/**
 * The action-token verifier a customer mounts in their own backend.
 *
 * The adoption constraint from doc 02 §2.1 is explicit: the user-facing
 * integration must stay under 40 lines, because if it is fiddly people reach for
 * a shared service key instead and the whole security model is lost. So the
 * design goal here is that everything hard is *inside* this function and the
 * caller writes one line.
 *
 * Framework-agnostic core; Express and Fastify adapters below are each a few
 * lines over it.
 */

export type VerifierOptions = {
  /** Keel's JWKS. Fetched once and cached by the caller, or supplied inline. */
  readonly jwks: { keys: JWK[] };
  /** This backend's audience, exactly as the tool contract declares it. */
  readonly audience: string;
  readonly issuer?: string;
  readonly replayCache?: ReplayCache;
  readonly approvalCache?: ReplayCache;
};

export type VerifierRequest = {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: unknown;
};

/**
 * Case-insensitive header lookup.
 *
 * Node and both frameworks normally lower-case header names, but not every
 * caller does — and a middleware that silently 401s every request because the
 * host sent `Authorization` is a miserable integration that pushes people back
 * to a shared service key. Scan rather than assume.
 */
const header = (req: VerifierRequest, name: string): string | undefined => {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
};

const bearer = (value: string | undefined): string | undefined =>
  value?.startsWith("Bearer ") === true ? value.slice(7) : undefined;

/**
 * Verifies one request. Returns the typed result; the adapters decide the
 * HTTP shape.
 *
 * The caches default to in-memory, which is correct for a single process and
 * documented as insufficient for more than one — a replay cache that is not
 * shared does not prevent replay against a different instance.
 */
export function createVerifier(options: VerifierOptions) {
  const replayCache = options.replayCache ?? new InMemoryReplayCache();
  const approvalCache = options.approvalCache ?? new InMemoryReplayCache();

  return async function verify(req: VerifierRequest): Promise<ActionVerifyResult> {
    return verifyActionToken(bearer(header(req, "authorization")), {
      jwks: options.jwks,
      audience: options.audience,
      ...(options.issuer === undefined ? {} : { issuer: options.issuer }),
      body: req.body,
      identityToken: header(req, "keel-identity"),
      replayCache,
      approvalCache,
    });
  };
}

/* ------------------------------------------------------------------ Express -- */

type Expressish = {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  keel?: unknown;
};
type ExpressRes = { status(code: number): { json(body: unknown): void } };

/** `app.use("/api", keelVerifier({ jwks, audience }))` — one line for the caller. */
export function keelVerifier(options: VerifierOptions) {
  const verify = createVerifier(options);

  return async (req: Expressish, res: ExpressRes, next: (error?: unknown) => void) => {
    const result = await verify({ headers: req.headers, body: req.body });

    if (!result.ok) {
      // One status for every failure. Distinguishing "expired" from "bad
      // signature" tells an attacker which half of their guess was right.
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    req.keel = result.action;
    next();
  };
}

/* ------------------------------------------------------------------ Fastify -- */

type Fastifyish = {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  keel?: unknown;
};
type FastifyReply = { code(status: number): { send(body: unknown): void } };

export function keelFastifyVerifier(options: VerifierOptions) {
  const verify = createVerifier(options);

  return async (request: Fastifyish, reply: FastifyReply): Promise<void> => {
    const result = await verify({ headers: request.headers, body: request.body });

    if (!result.ok) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    request.keel = result.action;
  };
}
