import type { ErrorClass } from "@keel/contracts";

/**
 * The lifecycle from docs/architecture/01 §4.3.
 *
 * This file is pure. No I/O, no clock, no randomness — `transition` is a total
 * function of (state, event), which is the property the whole design rests on:
 *
 *   - Replay is exact, because replaying is running the same reducer over the
 *     same events rather than interpreting a recorded outcome (§4.1).
 *   - A run survives process death, because the in-memory executor is only a
 *     cache over the step log.
 *   - Cancellation is a transition rather than an exception, so a cancelled run
 *     has a recorded reason like any other terminal state.
 */

export const RUN_STATES = [
  // Read path — reachable in this session.
  "Authenticating",
  "AssemblingContext",
  "ResolvingIntent",
  "Retrieving",
  "Planning",
  "Selecting",
  "Authorizing",
  "Executing",
  "Observing",
  "Verifying",
  "Responding",
  "Completed",
  "Denied",
  "Cancelled",
  "Failed",

  // Declared but unreachable until later slices. Present here so that the state
  // column, the trace UI and the replay reducer do not need widening when they
  // land — and so a run persisted by a newer version is still legible to an
  // older reader.
  "Deterministic",
  "AwaitingApproval",
  "WorkflowRunning",
  "Recovering",
  "Expired",
] as const;

export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_STATES = ["Completed", "Denied", "Cancelled", "Failed", "Expired"] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

export function isTerminal(state: RunState): state is TerminalState {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * What happened. One event per transition, persisted on the step that recorded
 * it — so `replay` reconstructs the event stream from the log rather than
 * trusting a stored `to` field, which could disagree with the reducer.
 */
export type RuntimeEvent =
  | { readonly type: "identity_verified" }
  | { readonly type: "identity_rejected"; readonly error_class: ErrorClass }
  | { readonly type: "context_assembled" }
  | { readonly type: "intent_resolved"; readonly intent: "knowledge" | "open" }
  | { readonly type: "retrieved" }
  | { readonly type: "planned"; readonly action: "call_tool" | "respond" }
  | { readonly type: "tool_selected" }
  | { readonly type: "authorized" }
  | { readonly type: "denied"; readonly rule_id: string }
  | { readonly type: "approval_required"; readonly approval_id: string; readonly mode: string }
  | { readonly type: "approval_granted"; readonly approval_id: string }
  | { readonly type: "approval_rejected"; readonly approval_id: string }
  | { readonly type: "approval_expired"; readonly approval_id: string }
  | { readonly type: "tool_executed" }
  | { readonly type: "observation_ok" }
  | { readonly type: "observation_failed"; readonly error_class: ErrorClass }
  | { readonly type: "verified"; readonly complete: boolean }
  | { readonly type: "responded" }
  | { readonly type: "cancelled" }
  | { readonly type: "failed"; readonly error_class: ErrorClass };

export class InvalidTransitionError extends Error {
  constructor(
    readonly state: RunState,
    readonly event: RuntimeEvent["type"],
  ) {
    super(`no transition from ${state} on ${event}`);
    this.name = "InvalidTransitionError";
  }
}

/**
 * The state machine.
 *
 * Deliberately total and deliberately strict: an event that does not belong in
 * the current state throws rather than being ignored. A silently dropped
 * transition would produce a run whose log and whose state disagree, and the
 * log is what evaluation and "why did it do that?" are built on.
 *
 * `cancelled` is accepted from every non-terminal state, because a user pressing
 * stop is not required to wait for a convenient moment.
 */
export function transition(state: RunState, event: RuntimeEvent): RunState {
  if (event.type === "cancelled") {
    if (isTerminal(state)) throw new InvalidTransitionError(state, event.type);
    return "Cancelled";
  }

  // A failure can also arrive from anywhere; the taxonomy decides what it means,
  // not the state it happened in.
  if (event.type === "failed") {
    if (isTerminal(state)) throw new InvalidTransitionError(state, event.type);
    return "Failed";
  }

  switch (state) {
    case "Authenticating":
      if (event.type === "identity_verified") return "AssemblingContext";
      if (event.type === "identity_rejected") return "Failed";
      break;

    case "AssemblingContext":
      if (event.type === "context_assembled") return "ResolvingIntent";
      break;

    case "ResolvingIntent":
      // A knowledge question retrieves first; an open task plans directly.
      if (event.type === "intent_resolved") {
        return event.intent === "knowledge" ? "Retrieving" : "Planning";
      }
      break;

    case "Retrieving":
      if (event.type === "retrieved") return "Planning";
      break;

    case "Planning":
      if (event.type === "planned") {
        return event.action === "call_tool" ? "Selecting" : "Responding";
      }
      break;

    case "Selecting":
      if (event.type === "tool_selected") return "Authorizing";
      break;

    case "Authorizing":
      if (event.type === "authorized") return "Executing";
      // The run suspends here. Nothing is held in memory: the approval row is
      // the state, so a restarted process resumes from it (doc 03 §C4).
      if (event.type === "approval_required") return "AwaitingApproval";
      // Denied is terminal, and the run still owes the user an explanation —
      // composed deterministically from the typed decision when the state is
      // entered, never by asking the model to guess why it failed (doc 01 §4.3).
      // Routing it through Responding would mean a model call, which is both
      // unnecessary and wrong when the denial *was* the budget running out.
      if (event.type === "denied") return "Denied";
      break;

    case "AwaitingApproval":
      if (event.type === "approval_granted") return "Executing";
      // A rejection is a denial, and gets the same explanation path.
      if (event.type === "approval_rejected") return "Denied";
      if (event.type === "approval_expired") return "Expired";
      break;

    case "Executing":
      if (event.type === "tool_executed") return "Observing";
      break;

    case "Observing":
      if (event.type === "observation_ok") return "Verifying";
      // Recovery lands in a later slice; until then a failed observation is
      // terminal rather than silently retried.
      if (event.type === "observation_failed") return "Failed";
      break;

    case "Verifying":
      if (event.type === "verified") return event.complete ? "Responding" : "Planning";
      break;

    case "Responding":
      if (event.type === "responded") return "Completed";
      break;

    default:
      break;
  }

  throw new InvalidTransitionError(state, event.type);
}

/** The step type each event is recorded under (doc 04 §B1 run_steps.type). */
export function stepTypeFor(event: RuntimeEvent): string {
  switch (event.type) {
    case "identity_verified":
    case "identity_rejected":
    case "context_assembled":
      return "context";
    case "intent_resolved":
    case "planned":
      return "route";
    case "retrieved":
      return "retrieval";
    case "tool_selected":
      return "model";
    case "authorized":
    case "denied":
      return "policy";
    case "tool_executed":
      return "tool";
    case "observation_ok":
    case "observation_failed":
    case "verified":
      return "verify";
    case "responded":
      return "response";
    case "approval_required":
    case "approval_granted":
    case "approval_rejected":
    case "approval_expired":
      return "approval";
    case "cancelled":
    case "failed":
      return "recover";
  }
}
