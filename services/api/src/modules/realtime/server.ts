import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AguiEvent } from "./events.js";
import { cancelRun, emit, endRun, getRun, type LiveRun, startRun } from "./registry.js";
import { encodeFrame, framesAfter, KEEPALIVE, SSE_HEADERS } from "./sse.js";

/**
 * The `/rt/v1` surface (doc 05 Part A): sessions, conversations, runs over SSE,
 * cancel.
 *
 * Built on node:http rather than a framework. This service is the deployable and
 * will grow a framework when it grows the rest of its HTTP surface; adding one
 * now to serve four endpoints would mean choosing it before the requirements
 * that should decide it exist.
 *
 * The run driver here is a placeholder in one specific sense, stated plainly:
 * it emits a scripted AG-UI sequence rather than invoking the agent runtime.
 * Wiring the runtime in is session 1.11's job, and the transport has to be
 * provably correct before something real is pushed through it. What is *not*
 * placeholder is everything the session's exit criterion names: ordering,
 * resume, and cancellation reaching the server.
 */

export type Sessions = Map<string, { id: string; anonymous: boolean; expires_at: number }>;

export type RealtimeDeps = {
  /** Drives one run, emitting events. Replaced with the agent runtime in 1.11. */
  readonly drive: (
    run: LiveRun,
    message: string,
    emitEvent: (e: AguiEvent) => void,
  ) => Promise<void>;
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
};

const problem = (res: ServerResponse, status: number, detail: string): void => {
  res.writeHead(status, { "content-type": "application/problem+json" });
  res.end(JSON.stringify({ type: "about:blank", title: "Error", status, detail }));
};

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The default driver: a realistic read-path sequence, used by the harness. */
export const scriptedDrive: RealtimeDeps["drive"] = async (run, message, emitEvent) => {
  emitEvent({ type: "RUN_STARTED", run_id: run.run_id });
  emitEvent({ type: "ACTIVITY", key: "resolving_intent", state: "started" });

  const callId = `call_${randomUUID().slice(0, 8)}`;
  emitEvent({ type: "TOOL_CALL_START", call_id: callId, tool: "list_customers" });
  emitEvent({ type: "ACTIVITY", key: "searching_customers", state: "started" });

  await new Promise((r) => setTimeout(r, 10));
  if (run.cancelled) return;

  emitEvent({ type: "TOOL_CALL_RESULT", call_id: callId, ok: true });
  emitEvent({ type: "TOOL_CALL_END", call_id: callId });
  emitEvent({ type: "ACTIVITY", key: "found_customers", state: "done", params: { count: 43 } });

  const messageId = `msg_${randomUUID().slice(0, 8)}`;
  emitEvent({ type: "TEXT_MESSAGE_START", message_id: messageId });

  for (const word of `Answering: ${message}`.split(" ")) {
    // Cancellation is checked between chunks, so a stop actually stops the work
    // rather than only closing the socket the tokens are travelling down.
    if (run.cancelled) return;
    await new Promise((r) => setTimeout(r, 5));
    emitEvent({ type: "TEXT_MESSAGE_CONTENT", message_id: messageId, delta: `${word} ` });
  }

  emitEvent({ type: "TEXT_MESSAGE_END", message_id: messageId });
  emitEvent({ type: "RUN_FINISHED", run_id: run.run_id, state: "Completed" });
};

export function createRealtimeServer(deps: RealtimeDeps = { drive: scriptedDrive }): {
  server: Server;
  sessions: Sessions;
} {
  const sessions: Sessions = new Map();
  const conversations = new Set<string>();

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => problem(res, 500, "internal error"));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const sessionId = req.headers["x-keel-session"];

    if (req.method === "POST" && path === "/rt/v1/sessions") {
      const body = await readBody(req);
      // An identity token would be verified here via @keel/identity. Absent one,
      // the session is anonymous and second-class — never elevated by default.
      const anonymous = typeof body["identity_token"] !== "string";
      const session = {
        id: `sess_${randomUUID()}`,
        anonymous,
        expires_at: Math.floor(Date.now() / 1000) + (anonymous ? 1800 : 3600),
      };
      sessions.set(session.id, session);
      return json(res, 201, session);
    }

    // Everything below requires a session. Nothing is reachable anonymously by
    // accident — an unknown session id is a 401, not a new session.
    if (typeof sessionId !== "string" || !sessions.has(sessionId)) {
      return problem(res, 401, "a valid session is required");
    }

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

      try {
        await deps.drive(run, message, (event) => {
          if (run.cancelled) return;
          res.write(encodeFrame(emit(run, event)));
        });

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
