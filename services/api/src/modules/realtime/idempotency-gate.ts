import type { IncomingMessage, ServerResponse } from "node:http";
import { problem } from "./http.js";

/**
 * `Idempotency-Key` on mutating endpoints (doc 02 §1, doc 05 Part A).
 *
 * Required, not optional. An optional header is one that clients omit, and the
 * first time anyone notices is when a user's double-click has started two runs
 * or recorded two decisions. Requiring it moves the failure from production to
 * the client author's first integration, which is the only place it is cheap.
 *
 * The gate stores the *response* against the key, so a repeat gets the original
 * answer rather than a fresh execution. That is what makes it a real guarantee
 * and not just a duplicate-rejection.
 */

export type ReplayedResponse = {
  readonly status: number;
  readonly body: string;
};

export type IdempotencyStore = {
  readonly claim: (key: string, ttlSeconds: number) => Promise<boolean>;
  readonly complete: (key: string, value: string, ttlSeconds: number) => Promise<void>;
  readonly read: (key: string) => Promise<string | undefined>;
  readonly release: (key: string) => Promise<void>;
};

/** 24 hours: longer than any retry window, shorter than a legitimate repeat. */
export const IDEMPOTENCY_TTL_SECONDS = 86_400;
/** How long a claim is held before an abandoned request stops blocking. */
export const CLAIM_TTL_SECONDS = 120;

export type GateOutcome =
  | { readonly status: "proceed"; readonly key: string }
  | { readonly status: "replayed" }
  | { readonly status: "refused" };

/**
 * Scoped by session and path as well as the key.
 *
 * A bare key would let one caller's key collide with another's, and a key
 * reused across two different endpoints would return the wrong endpoint's
 * answer — a class of bug that looks like data corruption rather than a header
 * mistake.
 */
export function scopeKey(sessionId: string, path: string, key: string): string {
  return `${sessionId}:${path}:${key}`;
}

export async function idempotencyGate(
  req: IncomingMessage,
  res: ServerResponse,
  input: { readonly sessionId: string; readonly path: string; readonly store: IdempotencyStore },
): Promise<GateOutcome> {
  const header = req.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;

  if (typeof key !== "string" || key.trim() === "") {
    problem(res, 400, "the Idempotency-Key header is required on this endpoint");
    return { status: "refused" };
  }

  if (key.length > 255) {
    problem(res, 400, "the Idempotency-Key header must be 255 characters or fewer");
    return { status: "refused" };
  }

  const scoped = scopeKey(input.sessionId, input.path, key);

  const previous = await input.store.read(scoped);
  if (previous !== undefined) {
    const replayed = JSON.parse(previous) as ReplayedResponse;
    res.writeHead(replayed.status, {
      "content-type": "application/json",
      // So a client can tell a replay from a fresh execution without diffing
      // the body — which matters when the body is identical by design.
      "idempotent-replay": "true",
    });
    res.end(replayed.body);
    return { status: "replayed" };
  }

  if (!(await input.store.claim(scoped, CLAIM_TTL_SECONDS))) {
    // A second request arrived while the first is still running. Answering it
    // would mean executing twice; guessing the first one's answer would mean
    // lying about what happened.
    problem(res, 409, "a request with this Idempotency-Key is already in flight");
    return { status: "refused" };
  }

  return { status: "proceed", key: scoped };
}

/** Records the response so a repeat replays it. */
export async function rememberResponse(
  store: IdempotencyStore,
  key: string,
  response: ReplayedResponse,
): Promise<void> {
  await store.complete(key, JSON.stringify(response), IDEMPOTENCY_TTL_SECONDS);
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  readonly #claims = new Map<string, number>();
  readonly #values = new Map<string, { value: string; expires: number }>();

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    const held = this.#claims.get(key);
    if (held !== undefined && held > now) return false;
    this.#claims.set(key, now + ttlSeconds * 1000);
    return true;
  }

  async complete(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.#claims.delete(key);
    this.#values.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
  }

  async read(key: string): Promise<string | undefined> {
    const entry = this.#values.get(key);
    if (entry === undefined) return undefined;
    if (entry.expires <= Date.now()) {
      this.#values.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async release(key: string): Promise<void> {
    this.#claims.delete(key);
  }
}
