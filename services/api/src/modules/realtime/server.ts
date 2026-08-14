import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  type ActionKeypair,
  actionJwks,
  generateActionKeypair,
  type IdentityConfig,
  InMemoryReplayCache,
  verifyIdentityToken,
} from "@keel/identity";
import { waitForDecision } from "./approval-waits.js";
import { handleDecide, type RecordDecision } from "./approvals-route.js";
import type { Drive, DriveContext } from "./drive.js";
import type { AguiEvent } from "./events.js";
import { json, problem, readBody } from "./http.js";
import { cancelRun, emit, endRun, getRun, startRun } from "./registry.js";
import { scriptedDrive } from "./scripted-drive.js";
import { encodeFrame, framesAfter, KEEPALIVE, SSE_HEADERS } from "./sse.js";

/**
 * The `/rt/v1` surface (doc 05 Part A): sessions, conversations, runs over SSE,
 * approval decisions, cancel.
 *
 * Built on node:http rather than a framework. This service is the deployable and
 * will grow a framework when it grows the rest of its HTTP surface; adding one
 * now to serve five endpoints would mean choosing it before the requirements
 * that should decide it exist.
 *
 * The default driver is scripted rather than the agent runtime — see
 * scripted-drive.ts, which says exactly what that does and does not cover.
 */

export type Sessions = Map<
  string,
  {
    id: string;
    anonymous: boolean;
    expires_at: number;
    subject?: string;
    identity_jti?: string;
  }
>;

export type RealtimeDeps = {
  readonly drive: Drive;
  /**
   * The project's identity configuration. When present, a supplied
   * identity_token is *verified* rather than merely observed.
   *
   * Absent, the endpoint serves anonymous sessions only and refuses a supplied
   * token outright — "no configuration" must never mean "believe whatever you
   * are told".
   */
  readonly identity?: IdentityConfig;
  /** A local key set, for tests. Production resolves the customer's JWKS. */
  readonly identityKeys?: { keys: unknown[] };
  /** A persisted signing keypair. Ephemeral by default. */
  readonly actionKeypair?: ActionKeypair;
  /**
   * Persists a decision before the suspended run is woken. Without it the
   * decision exists only in this process, which is precisely what durable
   * suspend is not.
   */
  readonly recordDecision?: RecordDecision;
  /** How long a suspended run holds its connection. 30 minutes by default. */
  readonly approvalTimeoutMs?: number;
};

export function createRealtimeServer(deps: RealtimeDeps = { drive: scriptedDrive }): {
  server: Server;
  sessions: Sessions;
} {
  const sessions: Sessions = new Map();
  const conversations = new Set<string>();
  const replayCache = new InMemoryReplayCache();

  // Generated once, lazily. A deployment supplies a persisted keypair; an
  // ephemeral one is the right default because it makes it impossible to ship a
  // signing key by accident.
  let keypair: Promise<ActionKeypair> | undefined;
  const actionKeys = (): Promise<ActionKeypair> => {
    keypair ??=
      deps.actionKeypair === undefined
        ? generateActionKeypair()
        : Promise.resolve(deps.actionKeypair);
    return keypair;
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => problem(res, 500, "internal error"));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const sessionId = req.headers["x-keel-session"];

    // Keel's public keys, so a customer backend can verify our action tokens.
    if (req.method === "GET" && path === "/.well-known/jwks.json") {
      return json(res, 200, await actionJwks(await actionKeys()));
    }

    if (req.method === "POST" && path === "/rt/v1/sessions") {
      const body = await readBody(req);
      const supplied = body["identity_token"];

      // No token: an anonymous session, second-class by construction.
      if (typeof supplied !== "string") {
        const session = {
          id: `sess_${randomUUID()}`,
          anonymous: true,
          expires_at: Math.floor(Date.now() / 1000) + 1800,
        };
        sessions.set(session.id, session);
        return json(res, 201, session);
      }

      // A token was supplied, so it is verified. Falling back to an anonymous
      // session here would be worse than refusing: the caller believes they are
      // authenticated and the platform believes they are not.
      if (deps.identity === undefined) {
        return problem(res, 401, "this project has no identity configuration");
      }

      const verified = await verifyIdentityToken(supplied, deps.identity, {
        replayCache,
        ...(deps.identityKeys === undefined ? {} : { localKeys: deps.identityKeys as never }),
      });

      if (!verified.ok) {
        // One status for every failure, so an attacker cannot learn which check
        // rejected them.
        return problem(res, 401, "the identity token was not accepted");
      }

      const session = {
        id: `sess_${randomUUID()}`,
        anonymous: false,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        subject: verified.identity.subject,
        identity_jti: verified.identity.jti,
      };
      sessions.set(session.id, session);
      return json(res, 201, session);
    }

    // Everything below requires a session. Nothing is reachable anonymously by
    // accident — an unknown session id is a 401, not a new session.
    if (typeof sessionId !== "string") return problem(res, 401, "a valid session is required");
    const session = sessions.get(sessionId);
    if (session === undefined) return problem(res, 401, "a valid session is required");

    if (req.method === "POST" && path === "/rt/v1/conversations") {
      const id = `conv_${randomUUID()}`;
      conversations.add(id);
      return json(res, 201, { id });
    }

    const runMatch = /^\/rt\/v1\/conversations\/([^/]+)\/runs$/.exec(path);
    if (req.method === "POST" && runMatch !== null) {
      const conversationId = runMatch[1] ?? "";
      if (!conversations.has(conversationId)) return problem(res, 404, "no such conversation");

      const body = await readBody(req);
      const message = typeof body["message"] === "string" ? body["message"] : "";

      const runId = `run_${randomUUID()}`;
      const run = startRun(runId, sessionId);

      res.writeHead(200, SSE_HEADERS);
      // The run id reaches the client before any event, so a cancel is possible
      // from the very first frame rather than only after RUN_STARTED arrives.
      res.write(
        encodeFrame(emit(run, { type: "CUSTOM", name: "run.id", payload: { run_id: runId } })),
      );

      const lastEventId =
        typeof req.headers["last-event-id"] === "string" ? req.headers["last-event-id"] : null;
      for (const frame of framesAfter(run.frames, lastEventId)) {
        if (frame.id > 1) res.write(encodeFrame(frame));
      }

      const keepalive = setInterval(() => res.write(KEEPALIVE), 15_000);
      // The client going away must stop the work, not just the writing.
      res.on("close", () => {
        clearInterval(keepalive);
        cancelRun(runId);
      });

      const emitEvent = (event: AguiEvent): void => {
        if (run.cancelled) return;
        res.write(encodeFrame(emit(run, event)));
      };

      const ctx: DriveContext = {
        requestApproval: async ({ approvalId, tool, mode, timeoutMs }) => {
          // The INTERRUPT goes out first. If the wait were registered after the
          // event, a decision arriving on a fast second connection would find
          // nobody listening and the run would hang until its deadline.
          const wait = { approval_id: approvalId, run_id: runId, session_id: sessionId, mode };
          const decision = waitForDecision(
            run,
            wait,
            timeoutMs ?? deps.approvalTimeoutMs ?? 1_800_000,
          );
          emitEvent({ type: "INTERRUPT", approval_id: approvalId, tool, mode });
          return decision;
        },
      };

      try {
        await deps.drive(run, message, emitEvent, ctx);

        if (run.cancelled) {
          res.write(
            encodeFrame(emit(run, { type: "RUN_FINISHED", run_id: runId, state: "Cancelled" })),
          );
        }
      } finally {
        clearInterval(keepalive);
        endRun(runId);
        res.end();
      }
      return;
    }

    const decideMatch = /^\/rt\/v1\/approvals\/([^/]+)\/decide$/.exec(path);
    if (req.method === "POST" && decideMatch !== null) {
      return handleDecide(req, res, {
        approvalId: decideMatch[1] ?? "",
        sessionId,
        // The identity subject when there is one. Never a body field: who
        // decided is not something the decider gets to assert.
        decidedBy: session.subject ?? sessionId,
        ...(deps.recordDecision === undefined ? {} : { recordDecision: deps.recordDecision }),
      });
    }

    const cancelMatch = /^\/rt\/v1\/runs\/([^/]+)\/cancel$/.exec(path);
    if (req.method === "POST" && cancelMatch !== null) {
      const runId = cancelMatch[1] ?? "";
      const run = getRun(runId);

      // A session may only cancel its own run. Without this check a session id
      // plus a guessed run id would stop someone else's work.
      if (run === undefined || run.session_id !== sessionId) {
        return problem(res, 404, "no such run");
      }

      cancelRun(runId);
      return json(res, 202, { run_id: runId, state: "Cancelling" });
    }

    return problem(res, 404, "not found");
  }

  return { server, sessions };
}
