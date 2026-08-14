import type { KeelError } from "@keel/contracts";

/**
 * Provider failures mapped into the taxonomy (doc 01 §5, §6).
 *
 * Nothing above this package should ever see an Anthropic error shape or an
 * OpenAI one. The runtime pattern-matches on the taxonomy and nothing else, so
 * a new provider is a new mapping here rather than a new branch everywhere.
 */

export type ProviderFailure = {
  readonly provider: string;
  readonly model: string;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  readonly message: string;
};

export function toKeelError(failure: ProviderFailure): KeelError {
  const { provider, model, status, message } = failure;

  // 429 is a rate limit whoever returned it. Honouring Retry-After rather than
  // guessing a backoff is the difference between recovering and being throttled
  // harder.
  if (status === 429) {
    return {
      class: "RateLimitError",
      message: `${provider}: ${message}`,
      scope: "provider",
      ...(failure.retryAfterSeconds === undefined
        ? {}
        : { retry_after_s: failure.retryAfterSeconds }),
    };
  }

  // 401/403 from a provider is our credential being wrong, not the end user's
  // permissions. Mapping it to AuthorizationError would tell the user they are
  // not permitted, which is both wrong and unactionable for them.
  if (status === 401 || status === 403) {
    return {
      class: "ModelProviderError",
      message: `${provider}: credential rejected (${status}) — ${message}`,
      provider,
      model,
      status,
    };
  }

  return {
    class: "ModelProviderError",
    message: `${provider}: ${message}`,
    provider,
    model,
    ...(status === undefined ? {} : { status }),
  };
}

/** A cancelled call is not a failure; it is the user getting what they asked for. */
export function isAbort(cause: unknown): boolean {
  if (cause instanceof Error) return cause.name === "AbortError" || cause.name === "TimeoutError";
  return false;
}

export class ProviderError extends Error {
  constructor(readonly failure: ProviderFailure) {
    super(failure.message);
    this.name = "ProviderError";
  }

  toKeelError(): KeelError {
    return toKeelError(this.failure);
  }
}
