import type { AddressInfo } from "node:net";
import {
  createRealtimeServer,
  framesAfter,
  type RealtimeDeps,
  resetRegistry,
  scriptedDrive,
} from "@keel/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AguiEvent, type ClientOptions, KeelClient, parseFrame } from "../src/index.js";

/**
 * The session's exit criterion: a Node harness drives a full run over SSE,
 * receives correctly ordered AG-UI events, and mid-stream cancellation is
 * observed *server-side*.
 *
 * A real HTTP server on a real socket, not a mock transport. Ordering and
 * cancellation are properties of the wire; a fake would assert that the fake
 * behaves, which is not the question.
 */

let server: ReturnType<typeof createRealtimeServer>["server"];
let endpoint: string;

async function listen(deps?: RealtimeDeps): Promise<void> {
  const created = createRealtimeServer(deps);
  server = created.server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  endpoint = `http://127.0.0.1:${port}`;
}

const client = (over: Partial<ClientOptions> = {}) =>
  new KeelClient({
    endpoint,
    projectId: "proj_1",
    identity: async () => null,
    ...over,
  });

beforeEach(() => {
  resetRegistry();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("session lifecycle", () => {
  it("establishes an anonymous session when the identity function returns null", async () => {
    await listen();
    const c = client();

    const session = await c.ensureSession();

    expect(session.anonymous).toBe(true);
    expect(session.id).toMatch(/^sess_/);
  });

  it("calls the identity function rather than holding a static token", async () => {
    await listen();
    let calls = 0;
    const c = client({
      identity: async () => {
        calls += 1;
        // Null, not a stub token: the endpoint now verifies anything it is
        // given, so a fake string is correctly refused. Verification itself is
        // covered below.
        return null;
      },
    });

    await c.ensureSession();
    expect(calls).toBe(1);

    // A live session is reused rather than re-fetching a token every request.
    await c.ensureSession();
    expect(calls).toBe(1);
  });

  it("refuses anything else without a session", async () => {
    await listen();
    const response = await fetch(`${endpoint}/rt/v1/conversations`, { method: "POST" });

    expect(response.status).toBe(401);
  });

  it("treats an unknown session id as unauthenticated, not as a new session", async () => {
    await listen();
    const response = await fetch(`${endpoint}/rt/v1/conversations`, {
      method: "POST",
      headers: { "x-keel-session": "sess_made_up" },
    });

    expect(response.status).toBe(401);
  });
});

describe("a full run over SSE", () => {
  it("delivers correctly ordered AG-UI events", async () => {
    await listen();
    const c = client();
    const received: AguiEvent[] = [];
    c.onAny((event) => received.push(event));

    const conversation = await c.createConversation();
    await c.run(conversation.id, "Show me inactive customers");

    const types = received.map((e) => e.type);

    // Ordering is the property, not the exact sequence: a run starts before it
    // finishes, a tool call opens before it resolves, and text streams between
    // its start and end markers.
    expect(types).toContain("RUN_STARTED");
    expect(types.at(-1)).toBe("RUN_FINISHED");
    expect(types.indexOf("RUN_STARTED")).toBeLessThan(types.indexOf("TOOL_CALL_START"));
    expect(types.indexOf("TOOL_CALL_START")).toBeLessThan(types.indexOf("TOOL_CALL_RESULT"));
    expect(types.indexOf("TEXT_MESSAGE_START")).toBeLessThan(types.indexOf("TEXT_MESSAGE_END"));
    expect(types.indexOf("TEXT_MESSAGE_END")).toBeLessThan(types.indexOf("RUN_FINISHED"));
  });

  it("streams text incrementally rather than delivering it at the end", async () => {
    await listen();
    const c = client();
    const deltas: string[] = [];
    c.on("TEXT_MESSAGE_CONTENT", (e) => deltas.push(e.delta));

    const conversation = await c.createConversation();
    await c.run(conversation.id, "one two three");

    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toContain("one");
  });

  it("surfaces ACTIVITY as status, which never reaches the model", async () => {
    await listen();
    const c = client();
    const activity: string[] = [];
    c.on("ACTIVITY", (e) => activity.push(e.key));

    const conversation = await c.createConversation();
    await c.run(conversation.id, "hello");

    expect(activity).toContain("searching_customers");
    expect(activity).toContain("found_customers");
  });
});

describe("cancellation reaches the server", () => {
  it("stops the run server-side, not merely the stream", async () => {
    // The property that matters: closing the socket is not cancelling. The run
    // must stop executing, or it keeps spending budget with nobody watching.
    let observedCancelled: boolean | undefined;

    await listen({
      drive: async (run, _message, emitEvent) => {
        emitEvent({ type: "RUN_STARTED", run_id: run.run_id });
        emitEvent({ type: "TEXT_MESSAGE_START", message_id: "m1" });

        for (let i = 0; i < 200; i += 1) {
          if (run.cancelled) {
            observedCancelled = true;
            return;
          }
          await new Promise((r) => setTimeout(r, 5));
          emitEvent({ type: "TEXT_MESSAGE_CONTENT", message_id: "m1", delta: `${i} ` });
        }
        observedCancelled = false;
      },
    });

    const c = client();
    let runId: string | null = null;

    c.on("CUSTOM", (event) => {
      if (event.name === "run.id") {
        runId = (event.payload as { run_id: string }).run_id;
      }
    });

    let seen = 0;
    c.on("TEXT_MESSAGE_CONTENT", () => {
      seen += 1;
      if (seen === 3 && runId !== null) void c.cancel(runId);
    });

    const conversation = await c.createConversation();
    await c.run(conversation.id, "count");

    // Give the server loop a tick to notice.
    await new Promise((r) => setTimeout(r, 50));

    expect(observedCancelled).toBe(true);
    expect(seen).toBeLessThan(200);
  });

  it("does not reconnect a stream the user cancelled", async () => {
    let driveCount = 0;
    await listen({
      drive: async (run, _m, emitEvent) => {
        driveCount += 1;
        emitEvent({ type: "RUN_STARTED", run_id: run.run_id });
        for (let i = 0; i < 100; i += 1) {
          if (run.cancelled) return;
          await new Promise((r) => setTimeout(r, 5));
          emitEvent({ type: "TEXT_MESSAGE_CONTENT", message_id: "m", delta: "x" });
        }
      },
    });

    const c = client();
    let runId: string | null = null;
    c.on("CUSTOM", (e) => {
      if (e.name === "run.id") runId = (e.payload as { run_id: string }).run_id;
    });
    c.on("TEXT_MESSAGE_CONTENT", () => {
      if (runId !== null) void c.cancel(runId);
    });

    const conversation = await c.createConversation();
    await c.run(conversation.id, "x");

    // Retrying a stream the user just stopped is the opposite of what they asked.
    expect(driveCount).toBe(1);
  });

  it("refuses to cancel another session's run", async () => {
    await listen();
    const owner = client();
    const stranger = client();

    let runId: string | null = null;
    owner.on("CUSTOM", (e) => {
      if (e.name === "run.id") runId = (e.payload as { run_id: string }).run_id;
    });

    const conversation = await owner.createConversation();
    await owner.run(conversation.id, "hi");
    await stranger.ensureSession();

    expect(runId).not.toBeNull();
    const response = await fetch(`${endpoint}/rt/v1/runs/${runId}/cancel`, {
      method: "POST",
      headers: { "x-keel-session": stranger.session?.id ?? "" },
    });

    expect(response.status).toBe(404);
  });

  it("cancels the run when the client simply disconnects", async () => {
    let stopped = false;
    await listen({
      drive: async (run, _m, emitEvent) => {
        emitEvent({ type: "RUN_STARTED", run_id: run.run_id });
        for (let i = 0; i < 100; i += 1) {
          if (run.cancelled) {
            stopped = true;
            return;
          }
          await new Promise((r) => setTimeout(r, 5));
          emitEvent({ type: "TEXT_MESSAGE_CONTENT", message_id: "m", delta: "x" });
        }
      },
    });

    const c = client();
    const conversation = await c.createConversation();

    const controller = new AbortController();
    const response = await fetch(`${endpoint}/rt/v1/conversations/${conversation.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-keel-session": c.session?.id ?? "" },
      body: JSON.stringify({ message: "x" }),
      signal: controller.signal,
    });

    const reader = response.body?.getReader();
    await reader?.read();
    controller.abort();

    await new Promise((r) => setTimeout(r, 100));
    expect(stopped).toBe(true);
  });
});

describe("frame parsing", () => {
  it("reads id and data", () => {
    const parsed = parseFrame('id: 7\ndata: {"type":"RUN_STARTED","run_id":"r"}');

    expect(parsed?.id).toBe("7");
    expect(parsed?.event.type).toBe("RUN_STARTED");
  });

  it("ignores keep-alive comments", () => {
    expect(parseFrame(": keep-alive")).toBeUndefined();
  });

  it("drops a malformed frame rather than ending the stream", () => {
    expect(parseFrame("data: {not json")).toBeUndefined();
    expect(parseFrame("data: 42")).toBeUndefined();
  });
});

describe("resume", () => {
  it("replays only the frames after last-event-id", () => {
    const frames = [1, 2, 3, 4, 5].map((id) => ({
      id,
      event: { type: "ACTIVITY", key: `k${id}`, state: "s" } as const,
    }));

    expect(framesAfter(frames, "3").map((f) => f.id)).toEqual([4, 5]);
    expect(framesAfter(frames, null).map((f) => f.id)).toEqual([1, 2, 3, 4, 5]);
    // A junk header must not silently drop the whole history.
    expect(framesAfter(frames, "not-a-number").map((f) => f.id)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("tool registration", () => {
  it("records tools without authorising anything", async () => {
    await listen();
    const c = client();

    c.registerTool({
      name: "export_csv",
      description: "Download the current list as CSV.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    });

    expect(c.registeredTools.map((t) => t.name)).toEqual(["export_csv"]);
  });
});

describe("reset", () => {
  it("drops the session and handlers on logout", async () => {
    await listen();
    const c = client();
    await c.ensureSession();

    expect(c.session).not.toBeNull();
    c.reset();
    expect(c.session).toBeNull();
  });
});

describe("identity verification is actually wired into /rt/v1/sessions", () => {
  it("refuses a supplied token when the project has no identity configuration", async () => {
    // Falling back to an anonymous session here would be worse than refusing:
    // the caller believes they are authenticated and the platform does not.
    await listen();

    const response = await fetch(`${endpoint}/rt/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: "p", identity_token: "anything-at-all" }),
    });

    expect(response.status).toBe(401);
  });

  it("refuses an unverifiable token when identity IS configured", async () => {
    const { generateIdentityKeypair, jwksFor } = await import("@keel/identity");
    const keypair = await generateIdentityKeypair("k1");

    await listen({
      drive: scriptedDrive,
      identity: {
        issuer: "https://app.example",
        jwksUri: "https://app.example/.well-known/jwks.json",
        audience: "keel:p",
        algorithms: ["EdDSA"],
        allowSymmetric: false,
      },
      identityKeys: (await jwksFor(keypair)) as never,
    });

    const response = await fetch(`${endpoint}/rt/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: "p", identity_token: "not.a.token" }),
    });

    expect(response.status).toBe(401);
  });

  it("accepts a genuinely verifiable token and binds the session to the subject", async () => {
    const { generateIdentityKeypair, jwksFor, mintIdentityToken } = await import("@keel/identity");
    const keypair = await generateIdentityKeypair("k1");

    await listen({
      drive: scriptedDrive,
      identity: {
        issuer: "https://app.example",
        jwksUri: "https://app.example/.well-known/jwks.json",
        audience: "keel:p",
        algorithms: ["EdDSA"],
        allowSymmetric: false,
      },
      identityKeys: (await jwksFor(keypair)) as never,
    });

    const { token } = await mintIdentityToken(keypair, {
      subject: "usr_42",
      issuer: "https://app.example",
      audience: "keel:p",
    });

    const response = await fetch(`${endpoint}/rt/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: "p", identity_token: token }),
    });

    expect(response.status).toBe(201);
    const session = (await response.json()) as { anonymous: boolean; subject?: string };
    expect(session.anonymous).toBe(false);
    expect(session.subject).toBe("usr_42");
  });

  it("publishes a JWKS so a customer backend can verify our action tokens", async () => {
    await listen();

    const response = await fetch(`${endpoint}/.well-known/jwks.json`);
    const body = (await response.json()) as { keys: { kty: string; alg: string }[] };

    expect(response.status).toBe(200);
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]?.alg).toBe("EdDSA");
    // Public material only — there is nothing secret in a JWKS, and a leaked
    // private component here would let anyone mint action tokens.
    expect(JSON.stringify(body)).not.toContain('"d"');
  });
});
