import type { KeelError } from "@keel/contracts";

/**
 * The outbound HTTP adapter (doc 01 §4.1, doc 02 §1).
 *
 * The end of the cancellation chain. Widget Stop → API → runtime → executor →
 * *here* → the socket. If the signal stops at any earlier link, the run appears
 * cancelled while the customer's backend is still working on a request whose
 * result nobody will read — and, for a mutation, still applying it.
 *
 * So the signal is passed to `fetch` rather than checked around it. Checking
 * before and after would abandon the response, not the request, which is the
 * distinction that matters to the machine on the other end.
 */

export type HttpCallInput = {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: unknown;
  readonly signal: AbortSignal;
  readonly tool: string;
  /** Sent as `Idempotency-Key` when the call has one. */
  readonly idempotencyKey: string | null;
  readonly fetchImpl?: typeof globalThis.fetch;
};

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

/**
 * Performs one call and classifies the outcome.
 *
 * Every failure leaves as a member of the taxonomy, because the Recovery
 * Manager pattern-matches on the class and an unclassified throw would be
 * treated as a generic execution error — which is retryable in circumstances
 * where it must not be.
 */
export async function httpCall(input: HttpCallInput): Promise<unknown> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;

  let response: Response;
  try {
    response = await fetchImpl(input.url, {
      method: input.method,
      headers: {
        ...input.headers,
        ...(input.idempotencyKey === null ? {} : { "idempotency-key": input.idempotencyKey }),
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: input.signal,
    });
  } catch {
    // An abort is not a failure of the tool, and must never be reported as one:
    // classified as a timeout it would be retried, which is the exact opposite
    // of what a user pressing Stop asked for.
    if (input.signal.aborted) throw new CancelledError();

    const reason = input.signal.reason;
    if (reason instanceof Error && reason.message === "timeout") {
      throw timeoutError(input.tool);
    }

    throw unavailable(input.tool, input.url);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw executionError(input.tool, response.status, detail);
  }

  const text = await response.text();
  if (text === "") return null;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A body that is not JSON is a contract mismatch, not a transport failure,
    // so it is not retried.
    throw executionError(input.tool, response.status, "the response was not JSON");
  }
}

function timeoutError(tool: string): KeelError {
  return {
    class: "ToolTimeoutError",
    message: "the call timed out",
    tool,
    timeout_ms: 0,
    idempotent: false,
  };
}

function unavailable(tool: string, target: string): KeelError {
  return {
    class: "ToolUnavailableError",
    // The target's own error text is not surfaced: it routinely contains
    // internal hostnames and stack traces.
    message: "the target could not be reached",
    tool,
    target,
  };
}

function executionError(tool: string, status: number, detail: string): KeelError {
  return {
    class: "ToolExecutionError",
    // Truncated, and never logged verbatim into model context: a backend's
    // error body is untrusted input like any other.
    message: detail.slice(0, 200),
    tool,
    status,
    idempotent: false,
  };
}
