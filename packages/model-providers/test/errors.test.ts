import { describe, expect, it } from "vitest";
import { isAbort, ProviderError, toKeelError } from "../src/errors.js";

const failure = (over: Partial<Parameters<typeof toKeelError>[0]> = {}) => ({
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  message: "boom",
  ...over,
});

describe("toKeelError", () => {
  it("maps 429 to RateLimitError and carries Retry-After", () => {
    const error = toKeelError(failure({ status: 429, retryAfterSeconds: 30 }));

    expect(error.class).toBe("RateLimitError");
    if (error.class !== "RateLimitError") return;
    expect(error.scope).toBe("provider");
    expect(error.retry_after_s).toBe(30);
  });

  it("maps 401 and 403 to ModelProviderError, not AuthorizationError", () => {
    // Our credential is wrong, not the end user's permissions. Telling the user
    // they are not permitted would be both false and unactionable for them.
    for (const status of [401, 403]) {
      const error = toKeelError(failure({ status }));
      expect(error.class).toBe("ModelProviderError");
    }
  });

  it("maps anything else to ModelProviderError with provenance", () => {
    const error = toKeelError(failure({ status: 500 }));

    expect(error.class).toBe("ModelProviderError");
    if (error.class !== "ModelProviderError") return;
    expect(error.provider).toBe("anthropic");
    expect(error.model).toBe("claude-sonnet-4-5");
    expect(error.status).toBe(500);
  });

  it("omits status entirely when there was no response", () => {
    const error = toKeelError(failure());

    expect(error.class).toBe("ModelProviderError");
    if (error.class !== "ModelProviderError") return;
    expect(error.status).toBeUndefined();
  });
});

describe("ProviderError", () => {
  it("converts itself into the taxonomy", () => {
    const error = new ProviderError(failure({ status: 429 }));

    expect(error.toKeelError().class).toBe("RateLimitError");
  });
});

describe("isAbort", () => {
  it("recognises cancellation and timeout, and nothing else", () => {
    expect(isAbort(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
    expect(isAbort(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe(true);
    expect(isAbort(new Error("ordinary"))).toBe(false);
    expect(isAbort("not an error")).toBe(false);
  });
});
