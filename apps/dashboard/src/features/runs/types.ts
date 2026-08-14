/** The shape the run-detail screen renders. Mirrors doc 04 §B1 run_steps. */
export type StepType =
  | "context"
  | "retrieval"
  | "model"
  | "tool"
  | "policy"
  | "approval"
  | "verify"
  | "recover"
  | "route"
  | "response";

export type StepStatus = "ok" | "error" | "skipped" | "pending";

export type RunStep = {
  readonly id: string;
  readonly seq: number;
  readonly type: StepType;
  readonly status: StepStatus;
  readonly integrity: string;
  readonly payload: Record<string, unknown>;
  readonly error_class: string | null;
  readonly tool_version_id: string | null;
  readonly model: string | null;
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly cost_usd: number;
  readonly latency_ms: number | null;
  readonly started_at: string;
};

export type RunDetail = {
  readonly id: string;
  readonly state: string;
  readonly agent_version_id: string;
  readonly environment: string;
  readonly model: string | null;
  readonly tool_versions: readonly string[];
  readonly knowledge_snapshot_id: string | null;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly total_latency_ms: number;
  readonly total_cost_usd: number;
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly steps: readonly RunStep[];
};

/** The policy decision recorded on a `policy` step (doc 03 §C2). */
export type PolicyDecision = {
  readonly effect: string;
  readonly rule_id: string;
  readonly reason?: string;
};

export function policyDecisionOf(step: RunStep): PolicyDecision | null {
  if (step.type !== "policy") return null;

  const ruleId = step.payload["rule_id"];
  if (typeof ruleId !== "string") return null;

  const event = step.payload["event"] as { type?: string } | undefined;
  return {
    effect: event?.type === "denied" ? "deny" : "allow",
    rule_id: ruleId,
    ...(typeof step.payload["reason"] === "string"
      ? { reason: step.payload["reason"] as string }
      : {}),
  };
}

/**
 * Step filtering, as a pure function.
 *
 * Extracted from the component so the behaviour is testable without driving a
 * portalled dropdown — the filter is the thing under test, not Radix's
 * keyboard handling, which `packages/ui` already covers.
 */
export function filterSteps(
  steps: readonly RunStep[],
  filters: { readonly type?: string; readonly status?: string },
): readonly RunStep[] {
  return steps.filter(
    (step) =>
      (filters.type === undefined || step.type === filters.type) &&
      (filters.status === undefined || step.status === filters.status),
  );
}
