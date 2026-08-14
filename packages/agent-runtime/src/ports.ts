import type { IntegrityLevel, KeelError } from "@keel/contracts";
import type { RunState, RuntimeEvent } from "./state.js";

/**
 * Every external dependency enters through one of these (doc 01 §3).
 *
 * This package has no runtime dependency on HTTP, Postgres, a model SDK or a
 * clock. That is not tidiness: it is what makes the runtime testable without a
 * network and replayable from a step log, which is in turn what makes
 * deterministic evaluation possible at all.
 *
 * Every method that can reach the outside takes an AbortSignal, so a cancelled
 * run stops paying for work rather than merely stopping rendering it.
 */

/* ------------------------------------------------------------------ clock -- */

export interface ClockPort {
  now(): number;
}

/* --------------------------------------------------------------------- id -- */

export interface IdPort {
  /** Prefixed ULIDs, matching the ids the database generates. */
  newId(prefix: string): string;
}

/* --------------------------------------------------------------- step log -- */

export type NewStep = {
  readonly run_id: string;
  readonly type: string;
  readonly status: "ok" | "error" | "skipped" | "pending";
  readonly integrity: IntegrityLevel;
  /** Carries the event, which is what makes replay a re-run rather than a read. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly error_class?: string;
  readonly tool_version_id?: string;
  readonly model?: string;
  readonly tokens_in?: number;
  readonly tokens_out?: number;
  readonly cost_usd?: number;
  readonly latency_ms?: number;
};

export type PersistedStep = NewStep & {
  readonly id: string;
  readonly seq: number;
  readonly started_at: number;
};

export interface StepLogPort {
  append(step: NewStep): Promise<PersistedStep>;
  /** In seq order. The run's whole history. */
  list(runId: string): Promise<readonly PersistedStep[]>;
}

/* ------------------------------------------------------------------ model -- */

export type Intent = { readonly kind: "knowledge" | "open"; readonly confidence: number };

export type PlannedAction =
  | {
      readonly kind: "call_tool";
      readonly tool: string;
      readonly arguments: Record<string, unknown>;
    }
  | { readonly kind: "respond"; readonly reason: string };

export type ModelUsage = {
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly cost_usd: number;
  readonly model: string;
  readonly latency_ms: number;
};

export interface ModelPort {
  /** Cheap classifier. Routes traffic away from the expensive path (§4.2). */
  classifyIntent(
    input: { readonly message: string },
    signal: AbortSignal,
  ): Promise<{ readonly intent: Intent; readonly usage: ModelUsage }>;

  /**
   * The planner (P-LLM). Sees trusted inputs and symbolic references only —
   * never raw untrusted content. The `context` it receives is already filtered
   * by the caller; this port cannot reach for more.
   */
  plan(
    input: {
      readonly message: string;
      readonly context: readonly ContextBlock[];
      readonly tools: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<{ readonly action: PlannedAction; readonly usage: ModelUsage }>;

  /** Composes the user-facing answer. Never invents a summary of a failed call. */
  compose(
    input: { readonly message: string; readonly observations: readonly string[] },
    signal: AbortSignal,
  ): Promise<{ readonly text: string; readonly usage: ModelUsage }>;
}

/* ----------------------------------------------------------------- policy -- */

export type PolicyInput = {
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  /** The taint of the arguments, for invariant I1. */
  readonly argument_integrity: IntegrityLevel;
  readonly environment: string;
};

export type PolicyDecision =
  | { readonly effect: "allow"; readonly rule_id: string }
  | { readonly effect: "deny"; readonly rule_id: string; readonly reason: string }
  /** Declared now; the runtime cannot reach AwaitingApproval until slice 2. */
  | { readonly effect: "require_approval"; readonly rule_id: string; readonly mode: string };

export interface PolicyPort {
  decide(input: PolicyInput, signal: AbortSignal): Promise<PolicyDecision>;
}

/* ------------------------------------------------------------------- tool -- */

export type ResolvedTool = {
  readonly name: string;
  readonly tool_version_id: string;
  readonly side_effect: "read" | "write" | "destructive";
  readonly risk: string;
};

export type ToolResult =
  | {
      readonly ok: true;
      readonly output: unknown;
      /** Output of a first-party tool carries the tool's declared level. */
      readonly integrity: IntegrityLevel;
      readonly latency_ms: number;
    }
  | { readonly ok: false; readonly error: KeelError; readonly latency_ms: number };

export interface ToolPort {
  resolve(name: string, signal: AbortSignal): Promise<ResolvedTool | undefined>;
  execute(
    call: { readonly tool: ResolvedTool; readonly arguments: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<ToolResult>;
}

/* -------------------------------------------------------------- knowledge -- */

export type ContextBlock = {
  readonly source: "system" | "developer" | "user" | "tool" | "knowledge";
  readonly text: string;
  /** Every block carries a label; nothing enters the model unlabelled (§4.2). */
  readonly integrity: IntegrityLevel;
};

export interface KnowledgePort {
  retrieve(
    query: { readonly text: string; readonly limit: number },
    signal: AbortSignal,
  ): Promise<readonly ContextBlock[]>;
}

/* ----------------------------------------------------------------- budget -- */

export interface BudgetPort {
  /**
   * Checked on entry to Planning and Executing (doc 01 §4.3). Returns the error
   * as a value, because exceeding a budget is a normal transition to Failed and
   * not an exceptional condition.
   */
  check(): KeelError | undefined;
  recordModelCall(usage: ModelUsage): void;
  recordToolCall(): void;
}

/* ------------------------------------------------------------------ ports -- */

export type Ports = {
  readonly clock: ClockPort;
  readonly id: IdPort;
  readonly stepLog: StepLogPort;
  readonly model: ModelPort;
  readonly policy: PolicyPort;
  readonly tool: ToolPort;
  readonly knowledge: KnowledgePort;
  readonly budget: BudgetPort;
};

/** What the executor carries between transitions. Persisted state is the log. */
export type RunSnapshot = {
  readonly run_id: string;
  readonly state: RunState;
  readonly seq: number;
  readonly observations: readonly string[];
  readonly answer?: string;
  readonly error_class?: string;
};

export type StepOutcome = {
  readonly snapshot: RunSnapshot;
  readonly event: RuntimeEvent;
  readonly step: PersistedStep;
};
