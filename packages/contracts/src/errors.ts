/**
 * The error taxonomy from docs/architecture/01 §6.
 *
 * A closed union, defined once, and the *only* thing the runtime pattern-matches
 * on. `catch (e)` without narrowing is a lint error (CLAUDE.md hard rule 2), so
 * every boundary that catches must funnel into one of these members.
 *
 * These are values, not thrown exceptions. The domain layer returns them; only
 * the outermost boundary turns one into an HTTP status or a process exit.
 */

/** Discriminant values. Stable strings — they appear in `run_steps.error_class`. */
export const ERROR_CLASSES = [
  "AuthenticationError",
  "AuthorizationError",
  "ApprovalRequiredError",
  "ApprovalRejectedError",
  "ApprovalExpiredError",
  "ToolValidationError",
  "ToolExecutionError",
  "ToolTimeoutError",
  "ToolUnavailableError",
  "KnowledgeRetrievalError",
  "ModelProviderError",
  "RateLimitError",
  "AgentLimitError",
  "PolicyViolationError",
  "WorkflowError",
  "IntegrationError",
] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

type Base<C extends ErrorClass> = {
  readonly class: C;
  /** Operator-facing. Never shown to an end user, may name internals. */
  readonly message: string;
  /** Correlates the error with the step that produced it. */
  readonly run_id?: string;
  readonly step_id?: string;
};

export type AuthenticationError = Base<"AuthenticationError"> & {
  readonly reason: "missing" | "malformed" | "expired" | "untrusted_issuer" | "bad_signature";
};

export type AuthorizationError = Base<"AuthorizationError"> & {
  /** Named so the user is told *what* is missing, not just "denied". */
  readonly missing_permission: string;
  readonly rule_id?: string;
};

/** Not a failure. Pauses the run; the Approval Manager owns the resumption. */
export type ApprovalRequiredError = Base<"ApprovalRequiredError"> & {
  readonly approval_id: string;
  readonly mode: "confirm" | "approve";
  readonly tool_version_id: string;
  readonly args_sha256: string;
};

export type ApprovalRejectedError = Base<"ApprovalRejectedError"> & {
  readonly approval_id: string;
  readonly decided_by?: string;
  readonly reason?: string;
};

export type ApprovalExpiredError = Base<"ApprovalExpiredError"> & {
  readonly approval_id: string;
  readonly expired_at: string;
};

/** The model produced arguments that fail the tool's input schema. */
export type ToolValidationError = Base<"ToolValidationError"> & {
  readonly tool: string;
  readonly issues: readonly { readonly path: string; readonly message: string }[];
  /** One repair attempt is allowed; the second is terminal. See `retryable`. */
  readonly repair_attempted: boolean;
};

export type ToolExecutionError = Base<"ToolExecutionError"> & {
  readonly tool: string;
  readonly status?: number;
  /** Set by the adapter. Governs retryability together with idempotency. */
  readonly idempotent: boolean;
};

export type ToolTimeoutError = Base<"ToolTimeoutError"> & {
  readonly tool: string;
  readonly timeout_ms: number;
  readonly idempotent: boolean;
};

export type ToolUnavailableError = Base<"ToolUnavailableError"> & {
  readonly tool: string;
  readonly target: string;
};

export type KnowledgeRetrievalError = Base<"KnowledgeRetrievalError"> & {
  readonly stage: "embed" | "search" | "rerank" | "fuse";
};

export type ModelProviderError = Base<"ModelProviderError"> & {
  readonly provider: string;
  readonly model: string;
  readonly status?: number;
};

export type RateLimitError = Base<"RateLimitError"> & {
  readonly scope: "provider" | "tool" | "project";
  /** Seconds, from `Retry-After` when the upstream supplied it. */
  readonly retry_after_s?: number;
};

export type AgentLimitError = Base<"AgentLimitError"> & {
  readonly limit: "cost_usd" | "model_calls" | "tool_calls" | "seconds" | "tokens";
  readonly budget: number;
  readonly consumed: number;
};

/** A taint invariant tripped. Logged at high severity — see doc 01 §4.4. */
export type PolicyViolationError = Base<"PolicyViolationError"> & {
  readonly invariant: "I1" | "I2";
  readonly rule_id?: string;
  readonly tool?: string;
};

export type WorkflowError = Base<"WorkflowError"> & {
  readonly workflow_version_id: string;
  readonly node_id?: string;
  readonly retryable: boolean;
};

export type IntegrationError = Base<"IntegrationError"> & {
  readonly protocol: "mcp" | "openapi";
  readonly endpoint?: string;
  readonly retryable: boolean;
};

export type KeelError =
  | AuthenticationError
  | AuthorizationError
  | ApprovalRequiredError
  | ApprovalRejectedError
  | ApprovalExpiredError
  | ToolValidationError
  | ToolExecutionError
  | ToolTimeoutError
  | ToolUnavailableError
  | KnowledgeRetrievalError
  | ModelProviderError
  | RateLimitError
  | AgentLimitError
  | PolicyViolationError
  | WorkflowError
  | IntegrationError;

export function isKeelError(value: unknown): value is KeelError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { class?: unknown; message?: unknown };
  return (
    typeof candidate.message === "string" &&
    typeof candidate.class === "string" &&
    (ERROR_CLASSES as readonly string[]).includes(candidate.class)
  );
}

/** One narrowing guard per member, so call sites never re-derive the check. */
export const isAuthenticationError = (e: KeelError): e is AuthenticationError =>
  e.class === "AuthenticationError";
export const isAuthorizationError = (e: KeelError): e is AuthorizationError =>
  e.class === "AuthorizationError";
export const isApprovalRequiredError = (e: KeelError): e is ApprovalRequiredError =>
  e.class === "ApprovalRequiredError";
export const isApprovalRejectedError = (e: KeelError): e is ApprovalRejectedError =>
  e.class === "ApprovalRejectedError";
export const isApprovalExpiredError = (e: KeelError): e is ApprovalExpiredError =>
  e.class === "ApprovalExpiredError";
export const isToolValidationError = (e: KeelError): e is ToolValidationError =>
  e.class === "ToolValidationError";
export const isToolExecutionError = (e: KeelError): e is ToolExecutionError =>
  e.class === "ToolExecutionError";
export const isToolTimeoutError = (e: KeelError): e is ToolTimeoutError =>
  e.class === "ToolTimeoutError";
export const isToolUnavailableError = (e: KeelError): e is ToolUnavailableError =>
  e.class === "ToolUnavailableError";
export const isKnowledgeRetrievalError = (e: KeelError): e is KnowledgeRetrievalError =>
  e.class === "KnowledgeRetrievalError";
export const isModelProviderError = (e: KeelError): e is ModelProviderError =>
  e.class === "ModelProviderError";
export const isRateLimitError = (e: KeelError): e is RateLimitError => e.class === "RateLimitError";
export const isAgentLimitError = (e: KeelError): e is AgentLimitError =>
  e.class === "AgentLimitError";
export const isPolicyViolationError = (e: KeelError): e is PolicyViolationError =>
  e.class === "PolicyViolationError";
export const isWorkflowError = (e: KeelError): e is WorkflowError => e.class === "WorkflowError";
export const isIntegrationError = (e: KeelError): e is IntegrationError =>
  e.class === "IntegrationError";

/**
 * Whether the error class *permits* a retry. It is not sufficient on its own.
 *
 * The full rule from doc 01 §6 is
 *   `retryable(error) && tool.idempotent && attempt < tool.retry.max`
 * and `isRetryable` deliberately answers only the first clause — see
 * `shouldRetryToolCall` below, which is the one call sites should reach for.
 *
 * `ApprovalRequiredError` is n/a in the doc's table: it is not a failure at all,
 * so retrying it is meaningless and the answer is false.
 */
export function isRetryable(error: KeelError): boolean {
  switch (error.class) {
    case "AuthenticationError":
    case "AuthorizationError":
    case "ApprovalRequiredError":
    case "ApprovalRejectedError":
    case "ApprovalExpiredError":
    case "AgentLimitError":
    case "PolicyViolationError":
      return false;

    // One repair attempt with the validation error fed back, then stop.
    case "ToolValidationError":
      return !error.repair_attempted;

    // Only a 5xx is worth repeating; a 4xx will fail identically.
    case "ToolExecutionError":
      return error.status !== undefined && error.status >= 500 && error.status < 600;

    case "ToolTimeoutError":
    case "ToolUnavailableError":
    case "KnowledgeRetrievalError":
    case "ModelProviderError":
    case "RateLimitError":
      return true;

    case "WorkflowError":
    case "IntegrationError":
      return error.retryable;
  }
}

/**
 * The complete retry rule, including the clause people forget.
 *
 * A destructive tool without an idempotency key is never retried, full stop —
 * so this takes idempotency explicitly rather than inferring it, and a caller
 * cannot get a "yes" by omitting the awkward argument.
 */
export function shouldRetryToolCall(
  error: KeelError,
  tool: { readonly idempotent: boolean; readonly retryMax: number },
  attempt: number,
): boolean {
  if (!isRetryable(error)) return false;
  if (attempt >= tool.retryMax) return false;

  // A validation repair re-plans the arguments; it does not re-send the same
  // call, so idempotency is not the relevant question there.
  if (error.class === "ToolValidationError") return true;

  return tool.idempotent;
}

/** Seconds to wait before a retry, when the upstream told us. */
export function retryAfterSeconds(error: KeelError): number | undefined {
  return error.class === "RateLimitError" ? error.retry_after_s : undefined;
}
