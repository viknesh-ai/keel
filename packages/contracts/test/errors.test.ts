import { describe, expect, it } from "vitest";
import {
  ERROR_CLASSES,
  isKeelError,
  isRetryable,
  type KeelError,
  retryAfterSeconds,
  shouldRetryToolCall,
} from "../src/errors.js";

const base = { message: "test" } as const;

/** One representative per class, so the exhaustiveness checks below are real. */
const SAMPLES: { [C in KeelError["class"]]: Extract<KeelError, { class: C }> } = {
  AuthenticationError: { ...base, class: "AuthenticationError", reason: "expired" },
  AuthorizationError: {
    ...base,
    class: "AuthorizationError",
    missing_permission: "customers.read",
  },
  ApprovalRequiredError: {
    ...base,
    class: "ApprovalRequiredError",
    approval_id: "apr_1",
    mode: "confirm",
    tool_version_id: "tv_1",
    args_sha256: "a".repeat(64),
  },
  ApprovalRejectedError: { ...base, class: "ApprovalRejectedError", approval_id: "apr_1" },
  ApprovalExpiredError: {
    ...base,
    class: "ApprovalExpiredError",
    approval_id: "apr_1",
    expired_at: "2026-08-13T10:00:00Z",
  },
  ToolValidationError: {
    ...base,
    class: "ToolValidationError",
    tool: "get_customer",
    issues: [{ path: "customer_id", message: "required" }],
    repair_attempted: false,
  },
  ToolExecutionError: {
    ...base,
    class: "ToolExecutionError",
    tool: "get_customer",
    status: 503,
    idempotent: true,
  },
  ToolTimeoutError: {
    ...base,
    class: "ToolTimeoutError",
    tool: "get_customer",
    timeout_ms: 5000,
    idempotent: true,
  },
  ToolUnavailableError: {
    ...base,
    class: "ToolUnavailableError",
    tool: "get_customer",
    target: "openapi",
  },
  KnowledgeRetrievalError: { ...base, class: "KnowledgeRetrievalError", stage: "search" },
  ModelProviderError: {
    ...base,
    class: "ModelProviderError",
    provider: "anthropic",
    model: "claude-sonnet",
  },
  RateLimitError: { ...base, class: "RateLimitError", scope: "provider", retry_after_s: 30 },
  AgentLimitError: {
    ...base,
    class: "AgentLimitError",
    limit: "cost_usd",
    budget: 0.5,
    consumed: 0.51,
  },
  PolicyViolationError: { ...base, class: "PolicyViolationError", invariant: "I1" },
  WorkflowError: { ...base, class: "WorkflowError", workflow_version_id: "wv_1", retryable: false },
  IntegrationError: { ...base, class: "IntegrationError", protocol: "mcp", retryable: true },
};

describe("the union is closed", () => {
  it("has a sample for every declared class", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...ERROR_CLASSES].sort());
  });

  it("isRetryable answers for every class without falling through", () => {
    for (const error of Object.values(SAMPLES)) {
      expect(typeof isRetryable(error)).toBe("boolean");
    }
  });
});

describe("isRetryable matches the table in doc 01 §6", () => {
  it.each([
    ["AuthenticationError", false],
    ["AuthorizationError", false],
    ["ApprovalRequiredError", false],
    ["ApprovalRejectedError", false],
    ["ApprovalExpiredError", false],
    ["ToolUnavailableError", true],
    ["KnowledgeRetrievalError", true],
    ["ModelProviderError", true],
    ["RateLimitError", true],
    ["AgentLimitError", false],
    ["PolicyViolationError", false],
  ] as const)("%s → %s", (className, expected) => {
    expect(isRetryable(SAMPLES[className])).toBe(expected);
  });

  it("allows one repair for a validation error, then stops", () => {
    expect(isRetryable(SAMPLES.ToolValidationError)).toBe(true);
    expect(isRetryable({ ...SAMPLES.ToolValidationError, repair_attempted: true })).toBe(false);
  });

  it("retries an execution error only on 5xx", () => {
    expect(isRetryable({ ...SAMPLES.ToolExecutionError, status: 503 })).toBe(true);
    expect(isRetryable({ ...SAMPLES.ToolExecutionError, status: 400 })).toBe(false);
    expect(isRetryable({ ...SAMPLES.ToolExecutionError, status: 404 })).toBe(false);
  });

  it("does not retry an execution error with no status — nothing says it is transient", () => {
    const { status: _omitted, ...withoutStatus } = SAMPLES.ToolExecutionError;

    expect(isRetryable(withoutStatus)).toBe(false);
  });

  it("defers to the carried flag for workflow and integration errors", () => {
    expect(isRetryable({ ...SAMPLES.WorkflowError, retryable: true })).toBe(true);
    expect(isRetryable({ ...SAMPLES.WorkflowError, retryable: false })).toBe(false);
    expect(isRetryable({ ...SAMPLES.IntegrationError, retryable: false })).toBe(false);
  });
});

describe("shouldRetryToolCall — the full rule", () => {
  const retryable = { idempotent: true, retryMax: 3 };

  it("permits a retry when the class allows it and the tool is idempotent", () => {
    expect(shouldRetryToolCall(SAMPLES.ToolTimeoutError, retryable, 0)).toBe(true);
  });

  it("never retries a non-idempotent tool, however retryable the class", () => {
    expect(
      shouldRetryToolCall(SAMPLES.ToolTimeoutError, { idempotent: false, retryMax: 3 }, 0),
    ).toBe(false);
    expect(
      shouldRetryToolCall(SAMPLES.ModelProviderError, { idempotent: false, retryMax: 3 }, 0),
    ).toBe(false);
  });

  it("stops at the attempt ceiling", () => {
    expect(shouldRetryToolCall(SAMPLES.ToolTimeoutError, retryable, 3)).toBe(false);
    expect(shouldRetryToolCall(SAMPLES.ToolTimeoutError, retryable, 4)).toBe(false);
  });

  it("never retries a class the taxonomy marks terminal", () => {
    expect(shouldRetryToolCall(SAMPLES.AuthorizationError, retryable, 0)).toBe(false);
    expect(shouldRetryToolCall(SAMPLES.PolicyViolationError, retryable, 0)).toBe(false);
    expect(shouldRetryToolCall(SAMPLES.AgentLimitError, retryable, 0)).toBe(false);
  });

  it("allows a validation repair on a non-idempotent tool, because it re-plans rather than re-sends", () => {
    expect(
      shouldRetryToolCall(SAMPLES.ToolValidationError, { idempotent: false, retryMax: 1 }, 0),
    ).toBe(true);
  });
});

describe("retryAfterSeconds", () => {
  it("surfaces Retry-After from a rate limit", () => {
    expect(retryAfterSeconds(SAMPLES.RateLimitError)).toBe(30);
  });

  it("is undefined for every other class", () => {
    expect(retryAfterSeconds(SAMPLES.ToolTimeoutError)).toBeUndefined();
  });
});

describe("isKeelError", () => {
  it("accepts a member of the union", () => {
    expect(isKeelError(SAMPLES.AuthenticationError)).toBe(true);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "AuthenticationError"],
    ["a native Error", new Error("boom")],
    ["an unknown class", { class: "SomethingElse", message: "x" }],
    ["a missing message", { class: "AuthenticationError" }],
  ])("rejects %s", (_label, value) => {
    expect(isKeelError(value)).toBe(false);
  });
});
