import type { IntegrityLevel } from "@keel/contracts";
import { meet } from "@keel/contracts";
import type {
  ContextBlock,
  PlannedAction,
  Ports,
  ResolvedTool,
  RunSnapshot,
  StepOutcome,
} from "./ports.js";
import { isTerminal, type RunState, type RuntimeEvent, stepTypeFor, transition } from "./state.js";

/**
 * The executor.
 *
 * It is a cache over the step log, not the source of truth (doc 01 §4.1). Every
 * transition appends a step *before* the snapshot advances, so a process that
 * dies between the two loses nothing: the log is authoritative and `replay`
 * re-derives the same state.
 *
 * The read path only. Approval and workflow states are declared in state.ts but
 * nothing here produces the events that reach them — a mutation that needed an
 * approval would be denied by policy rather than silently executed.
 */

export type RunInput = {
  readonly run_id: string;
  readonly message: string;
  readonly environment: string;
  /** Verified upstream. The runtime never accepts a client-supplied identity. */
  readonly identity_verified: boolean;
};

/** Working state the executor keeps between steps but does not persist directly. */
type Working = {
  snapshot: RunSnapshot;
  context: ContextBlock[];
  selected?: ResolvedTool;
  plannedArgs?: Record<string, unknown>;
  /** The taint of everything that has entered the run so far, for invariant I1. */
  taint: IntegrityLevel;
  planCount: number;
};

const MAX_PLAN_ITERATIONS = 8;

/**
 * The user-facing explanation for a denial, derived from the decision rather
 * than generated. Doc 01 §4.3: never ask the model why it failed.
 */
export function explainDenial(tool: string, reason: string): string {
  return `That would need "${tool}", which is not permitted here: ${reason}.`;
}

export function explainFailure(errorClass: string): string {
  switch (errorClass) {
    case "AuthenticationError":
      return "Your session could not be verified. Sign in again and retry.";
    case "AgentLimitError":
      return "This request reached its budget and was stopped before completing.";
    case "ToolUnavailableError":
      return "A capability this request needed could not be reached.";
    default:
      return "This request could not be completed.";
  }
}

export function initialSnapshot(runId: string): RunSnapshot {
  return { run_id: runId, state: "Authenticating", seq: 0, observations: [] };
}

/**
 * Appends the step for `event`, then advances the snapshot.
 *
 * Order matters and is the whole point: if the append succeeds and the process
 * dies, replay produces the post-transition state. If the append fails, nothing
 * moved. There is no window in which the run has advanced without a record.
 */
async function commit(
  ports: Ports,
  working: Working,
  event: RuntimeEvent,
  detail: {
    readonly status?: "ok" | "error" | "skipped";
    readonly integrity?: IntegrityLevel;
    readonly error_class?: string;
    readonly tool_version_id?: string;
    readonly model?: string;
    readonly tokens_in?: number;
    readonly tokens_out?: number;
    readonly cost_usd?: number;
    readonly latency_ms?: number;
    readonly extra?: Record<string, unknown>;
  } = {},
): Promise<StepOutcome> {
  const step = await ports.stepLog.append({
    run_id: working.snapshot.run_id,
    type: stepTypeFor(event),
    status: detail.status ?? "ok",
    integrity: detail.integrity ?? "system",
    payload: { event, ...(detail.extra ?? {}) },
    ...(detail.error_class === undefined ? {} : { error_class: detail.error_class }),
    ...(detail.tool_version_id === undefined ? {} : { tool_version_id: detail.tool_version_id }),
    ...(detail.model === undefined ? {} : { model: detail.model }),
    ...(detail.tokens_in === undefined ? {} : { tokens_in: detail.tokens_in }),
    ...(detail.tokens_out === undefined ? {} : { tokens_out: detail.tokens_out }),
    ...(detail.cost_usd === undefined ? {} : { cost_usd: detail.cost_usd }),
    ...(detail.latency_ms === undefined ? {} : { latency_ms: detail.latency_ms }),
  });

  const next = transition(working.snapshot.state, event);
  working.snapshot = {
    ...working.snapshot,
    state: next,
    seq: step.seq,
    ...(detail.error_class === undefined ? {} : { error_class: detail.error_class }),
    // A failed run still owes the user an explanation, and it comes from the
    // typed error rather than from another model call.
    ...(next === "Failed" && detail.error_class !== undefined
      ? { answer: explainFailure(detail.error_class) }
      : {}),
  };

  return { snapshot: working.snapshot, event, step };
}

/**
 * One transition.
 *
 * Cancellation is checked first and every time, so a stop reaches the run at the
 * next boundary rather than after the current phase happens to finish. It is a
 * transition rather than a thrown error, which means a cancelled run has a
 * recorded terminal state like any other.
 */
async function advance(
  ports: Ports,
  working: Working,
  input: RunInput,
  signal: AbortSignal,
): Promise<StepOutcome> {
  if (signal.aborted) return commit(ports, working, { type: "cancelled" }, { status: "skipped" });

  const state = working.snapshot.state;

  switch (state) {
    case "Authenticating": {
      if (!input.identity_verified) {
        return commit(
          ports,
          working,
          { type: "identity_rejected", error_class: "AuthenticationError" },
          { status: "error", error_class: "AuthenticationError" },
        );
      }
      return commit(ports, working, { type: "identity_verified" });
    }

    case "AssemblingContext": {
      working.context = [
        { source: "system", text: "Keel system instructions.", integrity: "system" },
        { source: "user", text: input.message, integrity: "user" },
      ];
      // The user's message is trusted-intent but untrusted-content; the label
      // records that rather than the runtime remembering it.
      working.taint = meet(...working.context.map((block) => block.integrity));
      return commit(ports, working, { type: "context_assembled" }, { integrity: working.taint });
    }

    case "ResolvingIntent": {
      const { intent, usage } = await ports.model.classifyIntent(
        { message: input.message },
        signal,
      );
      ports.budget.recordModelCall(usage);

      return commit(
        ports,
        working,
        { type: "intent_resolved", intent: intent.kind },
        {
          model: usage.model,
          tokens_in: usage.tokens_in,
          tokens_out: usage.tokens_out,
          cost_usd: usage.cost_usd,
          latency_ms: usage.latency_ms,
          extra: { confidence: intent.confidence },
        },
      );
    }

    case "Retrieving": {
      const blocks = await ports.knowledge.retrieve({ text: input.message, limit: 8 }, signal);
      working.context = [...working.context, ...blocks];
      // Retrieved content is external. Meeting it into the run's taint is what
      // later stops a mutation from taking arguments derived from it (I1).
      working.taint = meet(working.taint, ...blocks.map((b) => b.integrity));

      return commit(
        ports,
        working,
        { type: "retrieved" },
        { integrity: working.taint, extra: { chunks: blocks.length } },
      );
    }

    case "Planning": {
      // Budget is checked on entry to Planning (doc 01 §4.3).
      const exhausted = ports.budget.check();
      if (exhausted !== undefined) {
        return commit(
          ports,
          working,
          { type: "failed", error_class: exhausted.class },
          { status: "error", error_class: exhausted.class },
        );
      }

      // A bounded loop, not a while(true). Terminating by construction.
      if (working.planCount >= MAX_PLAN_ITERATIONS) {
        return commit(
          ports,
          working,
          { type: "failed", error_class: "AgentLimitError" },
          { status: "error", error_class: "AgentLimitError" },
        );
      }
      working.planCount += 1;

      const { action, usage } = await ports.model.plan(
        {
          message: input.message,
          // The planner sees trusted blocks only. External content reaches it as
          // a count, never as text — that is the planner/extractor split, and
          // filtering here rather than trusting the model is the point.
          context: working.context.filter((block) => block.integrity !== "external"),
          tools: ["get_customer", "list_invoices", "search_docs"],
        },
        signal,
      );
      ports.budget.recordModelCall(usage);

      return commitPlanned(ports, working, action, usage);
    }

    case "Selecting": {
      const name = working.selected?.name;
      if (name === undefined) {
        return commit(
          ports,
          working,
          { type: "failed", error_class: "ToolValidationError" },
          { status: "error", error_class: "ToolValidationError" },
        );
      }
      return commit(
        ports,
        working,
        { type: "tool_selected" },
        {
          ...(working.selected === undefined
            ? {}
            : { tool_version_id: working.selected.tool_version_id }),
        },
      );
    }

    case "Authorizing": {
      const tool = working.selected;
      if (tool === undefined) {
        return commit(
          ports,
          working,
          { type: "failed", error_class: "ToolValidationError" },
          { status: "error", error_class: "ToolValidationError" },
        );
      }

      const decision = await ports.policy.decide(
        {
          tool: tool.name,
          arguments: working.plannedArgs ?? {},
          argument_integrity: working.taint,
          environment: input.environment,
        },
        signal,
      );

      if (decision.effect === "allow") {
        return commit(
          ports,
          working,
          { type: "authorized" },
          { tool_version_id: tool.tool_version_id, extra: { rule_id: decision.rule_id } },
        );
      }

      // require_approval is unreachable on the read path: the approval manager
      // lands in slice 2. Treating it as a denial rather than quietly executing
      // is the safe reading, and it is recorded as such.
      //
      // The explanation is composed here, from the typed decision — doc 01 §4.3
      // requires that the user always gets one and that it is never produced by
      // asking the model to guess why it failed. Deterministic also means a
      // denial costs nothing, which matters when the denial *was* the budget.
      working.snapshot = {
        ...working.snapshot,
        answer: explainDenial(
          tool.name,
          decision.effect === "deny" ? decision.reason : "this action requires approval",
        ),
      };

      return commit(
        ports,
        working,
        { type: "denied", rule_id: decision.rule_id },
        {
          status: "error",
          error_class: "AuthorizationError",
          tool_version_id: tool.tool_version_id,
          extra: {
            rule_id: decision.rule_id,
            reason:
              decision.effect === "deny" ? decision.reason : "approval required, not yet supported",
          },
        },
      );
    }

    case "Executing": {
      const exhausted = ports.budget.check();
      if (exhausted !== undefined) {
        return commit(
          ports,
          working,
          { type: "failed", error_class: exhausted.class },
          { status: "error", error_class: exhausted.class },
        );
      }

      const tool = working.selected;
      if (tool === undefined) {
        return commit(
          ports,
          working,
          { type: "failed", error_class: "ToolValidationError" },
          { status: "error", error_class: "ToolValidationError" },
        );
      }

      const result = await ports.tool.execute(
        { tool, arguments: working.plannedArgs ?? {} },
        signal,
      );
      ports.budget.recordToolCall();

      if (result.ok) {
        working.snapshot = {
          ...working.snapshot,
          observations: [...working.snapshot.observations, JSON.stringify(result.output)],
        };
        working.taint = meet(working.taint, result.integrity);
      }

      return commit(
        ports,
        working,
        { type: "tool_executed" },
        {
          status: result.ok ? "ok" : "error",
          integrity: result.ok ? result.integrity : "system",
          tool_version_id: tool.tool_version_id,
          latency_ms: result.latency_ms,
          ...(result.ok ? {} : { error_class: result.error.class }),
          extra: result.ok ? {} : { error: result.error.class },
        },
      );
    }

    case "Observing": {
      const last = working.snapshot.observations.at(-1);
      return last === undefined
        ? commit(
            ports,
            working,
            { type: "observation_failed", error_class: "ToolExecutionError" },
            { status: "error", error_class: "ToolExecutionError" },
          )
        : commit(ports, working, { type: "observation_ok" }, { integrity: working.taint });
    }

    case "Verifying": {
      // Read-path verification: the observation exists and parsed. Post-condition
      // read-back for mutations lands with the write path in slice 2.
      return commit(ports, working, { type: "verified", complete: true });
    }

    case "Responding": {
      const { text, usage } = await ports.model.compose(
        { message: input.message, observations: working.snapshot.observations },
        signal,
      );
      ports.budget.recordModelCall(usage);
      working.snapshot = { ...working.snapshot, answer: text };

      return commit(
        ports,
        working,
        { type: "responded" },
        {
          model: usage.model,
          tokens_in: usage.tokens_in,
          tokens_out: usage.tokens_out,
          cost_usd: usage.cost_usd,
          latency_ms: usage.latency_ms,
        },
      );
    }

    default:
      return commit(
        ports,
        working,
        { type: "failed", error_class: "WorkflowError" },
        { status: "error", error_class: "WorkflowError" },
      );
  }
}

async function commitPlanned(
  ports: Ports,
  working: Working,
  action: PlannedAction,
  usage: {
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
    model: string;
    latency_ms: number;
  },
): Promise<StepOutcome> {
  const detail = {
    model: usage.model,
    tokens_in: usage.tokens_in,
    tokens_out: usage.tokens_out,
    cost_usd: usage.cost_usd,
    latency_ms: usage.latency_ms,
  };

  if (action.kind === "respond") {
    return commit(ports, working, { type: "planned", action: "respond" }, detail);
  }

  const resolved = await ports.tool.resolve(action.tool, new AbortController().signal);
  if (resolved === undefined) {
    return commit(
      ports,
      working,
      { type: "failed", error_class: "ToolUnavailableError" },
      { ...detail, status: "error", error_class: "ToolUnavailableError" },
    );
  }

  working.selected = resolved;
  working.plannedArgs = action.arguments;

  return commit(ports, working, { type: "planned", action: "call_tool" }, detail);
}

/**
 * Drives the run to a terminal state.
 *
 * `maxSteps` is a hard stop, not a suggestion: a machine that can loop is a
 * machine that will, and an unbounded executor is how a runaway run bills a
 * customer for an afternoon.
 */
export async function run(
  ports: Ports,
  input: RunInput,
  signal: AbortSignal,
  options: { readonly maxSteps?: number } = {},
): Promise<RunSnapshot> {
  const maxSteps = options.maxSteps ?? 64;

  const working: Working = {
    snapshot: initialSnapshot(input.run_id),
    context: [],
    taint: "system",
    planCount: 0,
  };

  for (let i = 0; i < maxSteps; i += 1) {
    if (isTerminal(working.snapshot.state)) return working.snapshot;
    await advance(ports, working, input, signal);
  }

  if (!isTerminal(working.snapshot.state)) {
    await commit(
      ports,
      working,
      { type: "failed", error_class: "AgentLimitError" },
      { status: "error", error_class: "AgentLimitError" },
    );
  }

  return working.snapshot;
}

/** Exposed for tests and for a worker that wants to drive one transition at a time. */
export async function step(
  ports: Ports,
  snapshot: RunSnapshot,
  input: RunInput,
  signal: AbortSignal,
): Promise<StepOutcome> {
  const working: Working = { snapshot, context: [], taint: "system", planCount: 0 };
  return advance(ports, working, input, signal);
}

export type { RunState };
