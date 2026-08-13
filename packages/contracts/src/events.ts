import { z } from "zod";
import { ERROR_CLASSES } from "./errors.js";

/**
 * The platform event union from docs/architecture/06 §A5.
 *
 * One bus, three deliveries: server webhook, SSE stream, SDK callback. Crow's
 * callbacks are browser-only, which makes backend reaction to `tool.failed`
 * impossible; closing that gap is what turns this into something you can build
 * operations on.
 *
 * These are *platform* events — the durable, backend-facing record. They are
 * not the AG-UI wire protocol; see agui.ts for the mapping and for which of
 * these never reach a browser.
 */

export const EVENT_TYPES = [
  "conversation.created",
  "message.created",
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "approval.requested",
  "approval.decided",
  "approval.expired",
  "workflow.started",
  "workflow.node.completed",
  "workflow.completed",
  "workflow.failed",
  "knowledge.sync.started",
  "knowledge.sync.completed",
  "knowledge.sync.failed",
  "policy.denied",
  "budget.exhausted",
  "evaluation.completed",
  "security.signal",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Present on every event. `id` is the dedupe key for at-least-once delivery;
 * consumers are expected to use it, and the docs say so.
 */
const envelope = {
  id: z.string().min(1),
  type: z.enum(EVENT_TYPES),
  project_id: z.string().min(1),
  /** RFC 3339. The signature covers `timestamp.body`. */
  created_at: z.string().min(1),
  run_id: z.string().optional(),
};

const event = <T extends z.ZodRawShape>(type: EventType, data: T) =>
  z.object({ ...envelope, type: z.literal(type), data: z.object(data) });

export const conversationCreatedSchema = event("conversation.created", {
  conversation_id: z.string(),
  agent_version_id: z.string(),
  identity_subject: z.string().optional(),
});

export const messageCreatedSchema = event("message.created", {
  conversation_id: z.string(),
  message_id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
});

export const runStartedSchema = event("run.started", {
  conversation_id: z.string().optional(),
  agent_version_id: z.string(),
  trigger: z.enum(["chat", "api", "webhook", "schedule", "eval"]),
  simulated: z.boolean(),
});

export const runCompletedSchema = event("run.completed", {
  duration_ms: z.int().min(0),
  cost_usd: z.number().min(0),
  tokens_in: z.int().min(0),
  tokens_out: z.int().min(0),
});

export const runFailedSchema = event("run.failed", {
  error_class: z.enum(ERROR_CLASSES),
  duration_ms: z.int().min(0),
});

export const runCancelledSchema = event("run.cancelled", {
  duration_ms: z.int().min(0),
  cancelled_by: z.enum(["user", "operator", "budget", "timeout"]),
});

export const toolStartedSchema = event("tool.started", {
  step_id: z.string(),
  tool: z.string(),
  tool_version_id: z.string(),
});

export const toolCompletedSchema = event("tool.completed", {
  step_id: z.string(),
  tool: z.string(),
  tool_version_id: z.string(),
  latency_ms: z.int().min(0),
});

export const toolFailedSchema = event("tool.failed", {
  step_id: z.string(),
  tool: z.string(),
  tool_version_id: z.string(),
  error_class: z.enum(ERROR_CLASSES),
  will_retry: z.boolean(),
});

export const approvalRequestedSchema = event("approval.requested", {
  approval_id: z.string(),
  tool: z.string(),
  mode: z.enum(["confirm", "approve"]),
  risk: z.enum(["read", "low", "high", "critical"]),
  expires_at: z.string(),
});

export const approvalDecidedSchema = event("approval.decided", {
  approval_id: z.string(),
  decision: z.enum(["approved", "rejected"]),
  decided_by: z.string(),
});

export const approvalExpiredSchema = event("approval.expired", {
  approval_id: z.string(),
});

export const workflowStartedSchema = event("workflow.started", {
  workflow_run_id: z.string(),
  workflow_version_id: z.string(),
});

export const workflowNodeCompletedSchema = event("workflow.node.completed", {
  workflow_run_id: z.string(),
  node_id: z.string(),
  iteration: z.int().min(0),
  status: z.enum(["ok", "skipped", "failed"]),
});

export const workflowCompletedSchema = event("workflow.completed", {
  workflow_run_id: z.string(),
  duration_ms: z.int().min(0),
});

export const workflowFailedSchema = event("workflow.failed", {
  workflow_run_id: z.string(),
  node_id: z.string().optional(),
  error_class: z.enum(ERROR_CLASSES),
});

export const knowledgeSyncStartedSchema = event("knowledge.sync.started", {
  source_id: z.string(),
});

export const knowledgeSyncCompletedSchema = event("knowledge.sync.completed", {
  source_id: z.string(),
  documents_added: z.int().min(0),
  documents_updated: z.int().min(0),
  documents_removed: z.int().min(0),
});

export const knowledgeSyncFailedSchema = event("knowledge.sync.failed", {
  source_id: z.string(),
  error_class: z.enum(ERROR_CLASSES),
});

export const policyDeniedSchema = event("policy.denied", {
  step_id: z.string().optional(),
  tool: z.string(),
  rule_id: z.string(),
  reason: z.string(),
});

export const budgetExhaustedSchema = event("budget.exhausted", {
  scope: z.enum(["run", "project_month"]),
  limit: z.enum(["cost_usd", "model_calls", "tool_calls", "seconds", "tokens"]),
  budget: z.number(),
  consumed: z.number(),
});

export const evaluationCompletedSchema = event("evaluation.completed", {
  evaluation_run_id: z.string(),
  dataset_id: z.string(),
  passed: z.int().min(0),
  failed: z.int().min(0),
  regressed: z.boolean(),
});

/** Emitted when a taint invariant trips or the attack corpus matches. */
export const securitySignalSchema = event("security.signal", {
  signal: z.enum([
    "invariant_i1_violation",
    "invariant_i2_violation",
    "injection_suspected",
    "egress_blocked",
    "identity_verification_failed",
  ]),
  severity: z.enum(["info", "warning", "critical"]),
  detail: z.string(),
});

export const platformEventSchema = z.discriminatedUnion("type", [
  conversationCreatedSchema,
  messageCreatedSchema,
  runStartedSchema,
  runCompletedSchema,
  runFailedSchema,
  runCancelledSchema,
  toolStartedSchema,
  toolCompletedSchema,
  toolFailedSchema,
  approvalRequestedSchema,
  approvalDecidedSchema,
  approvalExpiredSchema,
  workflowStartedSchema,
  workflowNodeCompletedSchema,
  workflowCompletedSchema,
  workflowFailedSchema,
  knowledgeSyncStartedSchema,
  knowledgeSyncCompletedSchema,
  knowledgeSyncFailedSchema,
  policyDeniedSchema,
  budgetExhaustedSchema,
  evaluationCompletedSchema,
  securitySignalSchema,
]);

export type PlatformEvent = z.infer<typeof platformEventSchema>;

export type EventOfType<T extends EventType> = Extract<PlatformEvent, { type: T }>;

export function isEventOfType<T extends EventType>(
  event: PlatformEvent,
  type: T,
): event is EventOfType<T> {
  return event.type === type;
}

export function parsePlatformEvent(
  candidate: unknown,
): { ok: true; event: PlatformEvent } | { ok: false; message: string } {
  const parsed = platformEventSchema.safeParse(candidate);
  return parsed.success
    ? { ok: true, event: parsed.data }
    : {
        ok: false,
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      };
}
