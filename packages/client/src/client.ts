import { type AguiEvent, type AguiEventType, Emitter, type Handler } from "./events.js";

/**
 * @keel/client — the framework-free browser core (doc 05 Part B).
 *
 * Every other frontend SDK is a thin binding over this, so nothing here may
 * assume React, a DOM framework, or a bundler. The only ambient APIs used are
 * `fetch`, `AbortController` and `TextDecoder`, all of which exist in browsers,
 * Node 22 and workers alike.
 *
 * The identity token is supplied as a **function**, never a string. A static
 * token would have to be long-lived to be useful, and a long-lived identity
 * token is a long-lived compromise (doc 03 §B2 caps them at ten minutes). The
 * function is called again whenever a session needs establishing or refreshing,
 * so the page can fetch a fresh one from its own backend.
 */

export type IdentityProvider = () => Promise<string | null>;

export type ClientOptions = {
  readonly endpoint: string;
  readonly projectId: string;
  /** Returns a fresh identity token, or null for an anonymous session. */
  readonly identity: IdentityProvider;
  readonly fetch?: typeof globalThis.fetch;
  /** Reconnection backoff ceiling. */
  readonly maxReconnectDelayMs?: number;
  readonly maxReconnectAttempts?: number;
};

export type Session = {
  readonly id: string;
  readonly anonymous: boolean;
  readonly expires_at: number;
};

export type ClientTool = {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
};

export class KeelClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "KeelClientError";
  }
}

const DEFAULT_MAX_DELAY = 10_000;
const DEFAULT_MAX_ATTEMPTS = 6;

export class KeelClient {
  readonly #options: ClientOptions;
  readonly #fetch: typeof globalThis.fetch;
  readonly #emitter = new Emitter();
  /** Registration only. Execution lands in slice 4 (doc 05 Part B). */
  readonly #tools = new Map<string, ClientTool>();

  #session: Session | null = null;
  #controller: AbortController | null = null;
  /** Resume point for a dropped stream. */
  #lastEventId: string | null = null;

  constructor(options: ClientOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  on<T extends AguiEventType>(type: T, handler: Handler<T>): () => void {
    return this.#emitter.on(type, handler);
  }

  onAny(handler: (event: AguiEvent) => void): () => void {
    return this.#emitter.onAny(handler);
  }

  /**
   * Registers a client-side tool. The server decides whether it is ever
   * offered — registering does not authorise anything, which is why this is
   * only a declaration and dispatch arrives later.
   */
  registerTool(tool: ClientTool): void {
    this.#tools.set(tool.name, tool);
  }

  get registeredTools(): readonly ClientTool[] {
    return [...this.#tools.values()];
  }

  get session(): Session | null {
    return this.#session;
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.#fetch(`${this.#options.endpoint}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(this.#session === null ? {} : { "x-keel-session": this.#session.id }),
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { detail?: string };
      throw new KeelClientError(response.status, body.detail ?? response.statusText);
    }

    return (await response.json()) as T;
  }

  /**
   * Establishes a session from a freshly-fetched identity token.
   *
   * Called on first use and again whenever the session has expired, so the
   * caller never has to think about refresh — which is what stops them holding
   * a token open for hours instead.
   */
  async ensureSession(): Promise<Session> {
    const current = this.#session;
    if (current !== null && current.expires_at * 1000 > Date.now() + 30_000) return current;

    const token = await this.#options.identity();

    const session = await this.#request<Session>("/rt/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        project_id: this.#options.projectId,
        ...(token === null ? {} : { identity_token: token }),
      }),
    });

    this.#session = session;
    return session;
  }

  async createConversation(): Promise<{ id: string }> {
    await this.ensureSession();
    return this.#request<{ id: string }>("/rt/v1/conversations", {
      method: "POST",
      body: JSON.stringify({ project_id: this.#options.projectId }),
    });
  }

  /**
   * Starts a run and consumes its AG-UI stream.
   *
   * Resolves when the stream terminates — normally, by cancellation, or after
   * reconnection attempts are exhausted. Events reach handlers as they arrive.
   */
  async run(conversationId: string, message: string): Promise<void> {
    await this.ensureSession();

    // Captured locally as well as stored. `reset()` clears the field, and a
    // reconnect loop that reads the field would then fail to notice it had been
    // stopped and would open a fresh run against a client that was logged out.
    const controller = new AbortController();
    this.#controller = controller;
    this.#lastEventId = null;

    let attempt = 0;
    const maxAttempts = this.#options.maxReconnectAttempts ?? DEFAULT_MAX_ATTEMPTS;

    while (attempt <= maxAttempts) {
      try {
        const finished = await this.#stream(conversationId, message);
        if (finished) return;
      } catch (cause) {
        // A cancel is not a failure and must not be retried: reconnecting a
        // stream the user just stopped is the opposite of what they asked for.
        if (controller.signal.aborted) return;
        if (attempt >= maxAttempts) throw cause;
      }

      if (controller.signal.aborted) return;

      attempt += 1;
      // Exponential with a ceiling. Reconnecting instantly in a loop against a
      // server that is already struggling makes the outage worse.
      const delay = Math.min(
        this.#options.maxReconnectDelayMs ?? DEFAULT_MAX_DELAY,
        2 ** attempt * 100,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /** Returns true when the stream ended because the run finished. */
  async #stream(conversationId: string, message: string): Promise<boolean> {
    const signal = this.#controller?.signal ?? new AbortController().signal;

    const response = await this.#fetch(
      `${this.#options.endpoint}/rt/v1/conversations/${conversationId}/runs`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...(this.#session === null ? {} : { "x-keel-session": this.#session.id }),
          // Resume from where the stream dropped rather than replaying it.
          ...(this.#lastEventId === null ? {} : { "last-event-id": this.#lastEventId }),
        },
        body: JSON.stringify({ message, tools: this.registeredTools.map((t) => t.name) }),
        signal,
      },
    );

    if (!response.ok || response.body === null) {
      throw new KeelClientError(response.status, "run stream could not be opened");
    }

    return this.#consume(response.body, signal);
  }

  /**
   * Reattaches to a run already in flight.
   *
   * This is how an approval survives a page reload: the server replays what the
   * run has already said, so a pending `INTERRUPT` arrives again and the card
   * comes back without any separate restore API.
   */
  async reattach(runId: string): Promise<void> {
    await this.ensureSession();
    this.#controller = new AbortController();
    const signal = this.#controller.signal;

    const response = await this.#fetch(`${this.#options.endpoint}/rt/v1/runs/${runId}/stream`, {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        ...(this.#session === null ? {} : { "x-keel-session": this.#session.id }),
        ...(this.#lastEventId === null ? {} : { "last-event-id": this.#lastEventId }),
      },
      signal,
    });

    if (!response.ok || response.body === null) {
      // A run that ended while the page was away is not an error worth showing.
      // There is simply nothing to reattach to.
      throw new KeelClientError(response.status, "run stream could not be reattached");
    }

    await this.#consume(response.body, signal);
  }

  /**
   * Answers a pending approval. `confirm` mode only; see doc 03 §C4.
   *
   * The idempotency key is minted here, per call, so a retry of *this* request
   * replays rather than deciding twice — while a genuinely new decision, made
   * after the first was refused, gets its own key.
   */
  async decide(approvalId: string, decision: "approved" | "rejected"): Promise<void> {
    await this.#request(`/rt/v1/approvals/${approvalId}/decide`, {
      method: "POST",
      headers: { "idempotency-key": newKey() },
      body: JSON.stringify({ decision }),
    });
  }

  async #consume(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<boolean> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finished = false;

    const onAbort = () => void reader.cancel().catch(() => undefined);
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const parsed = parseFrame(frame);
          if (parsed === undefined) continue;

          if (parsed.id !== undefined) this.#lastEventId = parsed.id;

          this.#emitter.emit(parsed.event);
          if (parsed.event.type === "RUN_FINISHED" || parsed.event.type === "RUN_ERROR") {
            finished = true;
          }
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      reader.releaseLock();
    }

    return finished;
  }

  /**
   * Stop the active run.
   *
   * Aborts locally *and* tells the server, because closing the stream alone
   * would leave the run executing and still spending budget — the cancellation
   * has to reach the worker (doc 01 §4.1).
   */
  async cancel(runId: string): Promise<void> {
    this.#controller?.abort();
    await this.#request(`/rt/v1/runs/${runId}/cancel`, { method: "POST" }).catch(() => undefined);
  }

  /** Drops the session and every handler. Used on logout. */
  reset(): void {
    this.#controller?.abort();
    this.#controller = null;
    this.#session = null;
    this.#lastEventId = null;
    this.#emitter.clear();
  }
}

/** A unique key per user action. `randomUUID` exists in browsers and Node 22. */
function newKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  // Older embedded webviews. Collision risk is irrelevant here: the key is
  // scoped to one session and one path, and only has to be unique against that
  // session's own recent requests.
  return `k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

/** Parses one SSE frame. Returns undefined for comments and keep-alives. */
export function parseFrame(frame: string): { event: AguiEvent; id?: string } | undefined {
  let data = "";
  let id: string | undefined;

  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }

  if (data === "") return undefined;

  try {
    const event = JSON.parse(data) as AguiEvent;
    if (typeof event !== "object" || event === null || typeof event.type !== "string") {
      return undefined;
    }
    return id === undefined ? { event } : { event, id };
  } catch {
    // A malformed frame is dropped rather than throwing: one bad frame must not
    // end a stream that is otherwise fine.
    return undefined;
  }
}
