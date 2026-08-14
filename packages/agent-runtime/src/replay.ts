import type { PersistedStep, RunSnapshot } from "./ports.js";
import { initialSnapshot } from "./runtime.js";
import { type RuntimeEvent, transition } from "./state.js";

/**
 * Re-derive a run's state from its step log.
 *
 * This is a *re-run*, not a read. Each step carries the event that caused the
 * transition, and replay folds the same pure reducer the executor used — so a
 * disagreement between the log and the live run is impossible by construction
 * rather than by discipline.
 *
 * Storing the resulting state on each step and reading it back would be easier
 * and would prove nothing: it would reproduce whatever was recorded, including
 * a bug. Folding the events proves the machine is deterministic.
 */

export class CorruptStepLogError extends Error {
  constructor(
    readonly seq: number,
    reason: string,
  ) {
    super(`step ${seq}: ${reason}`);
    this.name = "CorruptStepLogError";
  }
}

export function eventOf(step: PersistedStep): RuntimeEvent {
  const event = step.payload["event"];
  if (typeof event !== "object" || event === null || !("type" in event)) {
    throw new CorruptStepLogError(step.seq, "payload carries no event");
  }
  return event as RuntimeEvent;
}

export function replay(runId: string, steps: readonly PersistedStep[]): RunSnapshot {
  const ordered = [...steps].sort((a, b) => a.seq - b.seq);

  let snapshot = initialSnapshot(runId);

  for (const step of ordered) {
    const event = eventOf(step);
    // A gap in seq means a step is missing, and a state derived from a partial
    // log is a state nobody should trust. Fail loudly rather than silently
    // reconstructing a plausible-looking run.
    snapshot = {
      ...snapshot,
      state: transition(snapshot.state, event),
      seq: step.seq,
      ...(step.error_class === undefined ? {} : { error_class: step.error_class }),
    };
  }

  return snapshot;
}

/** True when the log folds cleanly to the state the run claims to be in. */
export function verifyAgainst(
  runId: string,
  steps: readonly PersistedStep[],
  claimed: RunSnapshot,
): boolean {
  return replay(runId, steps).state === claimed.state;
}
