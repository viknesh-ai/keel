import { z } from "zod";
import { ERROR_CLASSES } from "./errors.js";

/**
 * The tool contract from docs/architecture/02 §1 and §2.
 *
 * One contract, many execution targets: the model sees a uniform catalogue, the
 * runtime a uniform contract, the policy engine a uniform decision input.
 *
 * Zod is the source of truth (ADR-008). TS types are inferred from these
 * schemas and JSON Schema is emitted from them, so the three can never drift.
 */

export const TOOL_TARGETS = [
  "server",
  "client",
  "mcp",
  "openapi",
  "workflow",
  "knowledge",
  "navigation",
] as const;

/** Mechanical: does it mutate? Drives retry, idempotency and caching. */
export const SIDE_EFFECTS = ["read", "write", "destructive"] as const;

/**
 * Business judgment: how bad if wrong? Drives approval.
 *
 * Deliberately separate from side_effect. `export_all_customers` is a *read*
 * with *high* risk; collapsing the two into one field is the most common
 * mistake in this space (doc 02 §1).
 */
export const RISK_LEVELS = ["read", "low", "high", "critical"] as const;

export const toolTargetSchema = z.enum(TOOL_TARGETS);
export const sideEffectSchema = z.enum(SIDE_EFFECTS);
export const riskLevelSchema = z.enum(RISK_LEVELS);
export const errorClassSchema = z.enum(ERROR_CLASSES);

/**
 * Credential binding — the confused-deputy fix (doc 02 §2).
 *
 * `user_action_token` is the default for anything mutating: the customer's
 * backend receives a token chained to the identity token their own IdP minted
 * and bound to this specific call, rather than a service key plus a claimed
 * user id it has no way to verify.
 */
export const authBindingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("service"), secret_ref: z.string().min(1) }),
  z.object({ kind: z.literal("user_action_token") }),
  z.object({
    kind: z.literal("user_oauth"),
    provider: z.string().min(1),
    scopes: z.array(z.string().min(1)),
  }),
  z.object({ kind: z.literal("org_credential"), provider: z.string().min(1) }),
]);

export type AuthBinding = z.infer<typeof authBindingSchema>;

/**
 * A JSON Schema object. Not modelled structurally: these are handed to model
 * providers verbatim and over-constraining them here would reject valid schemas
 * for no benefit. `additionalProperties: false` is required, though — see
 * threat-model §T8 on argument injection.
 */
export const jsonSchemaSchema = z.looseObject({
  type: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).optional(),
  additionalProperties: z.unknown().optional(),
});

export const retrySchema = z.object({
  max: z.int().min(0).max(10),
  backoff: z.enum(["none", "exponential"]),
  on: z.array(errorClassSchema),
});

export const idempotencySchema = z.object({
  required: z.boolean(),
  /** Argument paths whose values form the idempotency key. */
  key_from: z.array(z.string().min(1)).optional(),
});

export const cacheSchema = z.object({
  ttl_s: z.int().min(0),
  key_from: z.array(z.string().min(1)),
  /**
   * Defaults to true. Caching a per-user read across users is a cross-tenant
   * leak, so opting out is explicit and the policy linter warns about it.
   */
  vary_by_identity: z.boolean().default(true),
});

export const concurrencySchema = z.object({
  group: z.string().min(1).optional(),
  max: z.int().min(1).optional(),
});

export const toolExampleSchema = z.object({
  input: z.unknown(),
  output: z.unknown(),
  note: z.string().optional(),
});

/**
 * Shape only. The cross-field rules that actually matter live in
 * `validateToolContract`, because they need to produce named, explainable
 * failures at registration time rather than a Zod issue path.
 */
export const toolContractSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, "must be snake_case, starting with a letter"),
  version: z.int().min(1),
  title: z.string().min(1).max(120),
  /** The single biggest lever on selection accuracy (doc 02 §1). */
  description: z.string().min(1).max(2000),
  input: jsonSchemaSchema,
  output: jsonSchemaSchema,

  target: toolTargetSchema,
  side_effect: sideEffectSchema,
  risk: riskLevelSchema,

  auth: authBindingSchema,
  /** Default false. Governs invariant I1. */
  accepts_untrusted_args: z.boolean().default(false),
  /** Allowlisted destinations for invariant I2. */
  egress: z.array(z.string().min(1)).optional(),

  /** Required. No tool may hang forever; the schema rejects absence. */
  timeout_ms: z.int().min(1).max(600_000),
  retry: retrySchema,
  idempotency: idempotencySchema,
  cache: cacheSchema.optional(),
  concurrency: concurrencySchema.optional(),

  examples: z.array(toolExampleSchema).optional(),
  renderer: z.string().min(1).optional(),
});

export type ToolContract = z.infer<typeof toolContractSchema>;
/** The pre-parse shape, where defaulted fields may be absent. */
export type ToolContractInput = z.input<typeof toolContractSchema>;

export type ToolContractIssue = {
  readonly code:
    | "schema"
    | "idempotency_required_for_mutation"
    | "ambient_write_credential"
    | "unsafe_additional_properties"
    | "egress_required_for_untrusted_args"
    | "retry_on_unretryable_class"
    | "destructive_retry_without_key";
  readonly path: string;
  readonly message: string;
};

export type ToolContractResult =
  | { readonly ok: true; readonly contract: ToolContract }
  | { readonly ok: false; readonly issues: readonly ToolContractIssue[] };

export type ValidateOptions = {
  /**
   * Set per project. Permits `auth.kind === "service"` on a mutating tool.
   * Ambient admin credentials plus an LLM is how you build a machine that can
   * do anything to anyone, so this is opt-in and the reviewer acknowledges it
   * in config (doc 02 §2).
   */
  readonly allowAmbientWrite?: boolean;
};

/**
 * Registration-time validation. Every rule here is one the docs state as
 * enforced at registration rather than discovered at runtime.
 *
 * Returns all issues rather than the first, so a tool author fixes their
 * contract in one pass.
 */
export function validateToolContract(
  candidate: unknown,
  options: ValidateOptions = {},
): ToolContractResult {
  const parsed = toolContractSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        code: "schema" as const,
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }

  const contract = parsed.data;
  const issues: ToolContractIssue[] = [];
  const mutates = contract.side_effect !== "read";

  // doc 02 §1: forced to true when side_effect != read.
  if (mutates && !contract.idempotency.required) {
    issues.push({
      code: "idempotency_required_for_mutation",
      path: "idempotency.required",
      message: `side_effect is "${contract.side_effect}", so idempotency.required must be true — a mutation that cannot be de-duplicated cannot be safely retried or resumed`,
    });
  }

  // doc 02 §2: no ambient service credential on a mutating tool.
  if (mutates && contract.auth.kind === "service" && options.allowAmbientWrite !== true) {
    issues.push({
      code: "ambient_write_credential",
      path: "auth.kind",
      message: `a ${contract.side_effect} tool may not use a service credential unless the project sets allow_ambient_write: true — use user_action_token so the call carries the end user's identity`,
    });
  }

  // threat-model §T8: closed argument domains.
  for (const field of ["input", "output"] as const) {
    if (contract[field].additionalProperties !== false) {
      issues.push({
        code: "unsafe_additional_properties",
        path: `${field}.additionalProperties`,
        message: `${field} schema must set additionalProperties: false so the argument domain is closed`,
      });
    }
  }

  // A tool that opts out of I1 must say where data may go, or I2 is unbounded.
  if (contract.accepts_untrusted_args && mutates) {
    if (contract.egress === undefined || contract.egress.length === 0) {
      issues.push({
        code: "egress_required_for_untrusted_args",
        path: "egress",
        message:
          "a mutating tool that accepts untrusted arguments must declare an egress allowlist — it has opted out of I1, so I2 is the only remaining confinement",
      });
    }
  }

  // Retrying on a class that is never retryable is dead configuration, and
  // reads as a safety guarantee that does not exist.
  const NEVER_RETRYABLE = new Set([
    "AuthenticationError",
    "AuthorizationError",
    "ApprovalRequiredError",
    "ApprovalRejectedError",
    "ApprovalExpiredError",
    "AgentLimitError",
    "PolicyViolationError",
  ]);
  for (const [index, errorClass] of contract.retry.on.entries()) {
    if (NEVER_RETRYABLE.has(errorClass)) {
      issues.push({
        code: "retry_on_unretryable_class",
        path: `retry.on.${index}`,
        message: `${errorClass} is never retryable — listing it here has no effect and misleads the reader`,
      });
    }
  }

  // "A destructive tool without an idempotency key is never retried, full stop."
  if (
    contract.side_effect === "destructive" &&
    contract.retry.max > 0 &&
    (contract.idempotency.key_from === undefined || contract.idempotency.key_from.length === 0)
  ) {
    issues.push({
      code: "destructive_retry_without_key",
      path: "idempotency.key_from",
      message:
        "a destructive tool with retry.max > 0 must declare idempotency.key_from — it would otherwise be retried without any way to detect a duplicate",
    });
  }

  return issues.length === 0 ? { ok: true, contract } : { ok: false, issues };
}

/**
 * Default approval mode per risk and environment (doc 02 §1).
 *
 * `confirm` = the asking user confirms in the widget.
 * `approve` = a *different* principal decides. That distinction matters:
 * "the user clicked yes" is not an authorization control when the user is the
 * attacker.
 */
export const APPROVAL_MODES = ["auto", "confirm", "approve"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export type Environment = "development" | "staging" | "production";

export function defaultApprovalMode(risk: RiskLevel, environment: Environment): ApprovalMode {
  if (environment === "development") return "auto";
  switch (risk) {
    case "read":
    case "low":
      return "auto";
    case "high":
      return "confirm";
    case "critical":
      return environment === "production" ? "approve" : "approve";
  }
}

export type ToolTarget = (typeof TOOL_TARGETS)[number];
export type SideEffect = (typeof SIDE_EFFECTS)[number];
export type RiskLevel = (typeof RISK_LEVELS)[number];
