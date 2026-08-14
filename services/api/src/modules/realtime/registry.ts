import type { AguiEvent } from "./events.js";
import type { SseFrame } from "./sse.js";

/**
 * In-process registry of live runs.
 *
 * Holds the cancellation signal and the frames emitted so far, so that a
 * reconnecting client can resume and a cancel can reach the work rather than
 * only closing the socket.
 *
 * In-process is correct for a single deployable (ADR-001) and explicitly not
 * correct once workers are distributed — at which point cancellation moves to
 * Redis and this becomes a cache over it. Naming that now so the boundary is
 * visible rather than discovered.
 */

export type LiveRun = {
  readonly run_id: string;
  readonly session_id: string;
  readonly controller: AbortController;
  readonly frames: SseFrame[];
  cancelled: boolean;
  nextId: number;
};

const runs = new Map<string, LiveRun>();

export function startRun(run_id: string, session_id: string): LiveRun {
  const run: LiveRun = {
    run_id,
    session_id,
    controller: new AbortController(),
    frames: [],
    cancelled: false,
    nextId: 1,
  };
  runs.set(run_id, run);
  return run;
}

export function getRun(run_id: string): LiveRun | undefined {
  return runs.get(run_id);
}

export function emit(run: LiveRun, event: AguiEvent): SseFrame {
  const frame: SseFrame = { id: run.nextId, event };
  run.nextId += 1;
  run.frames.push(frame);
  return frame;
}

/**
 * Cancels a run. Returns false when there is nothing to cancel, so the endpoint
 * can answer 404 rather than pretending it stopped something.
 */
export function cancelRun(run_id: string): boolean {
  const run = runs.get(run_id);
  if (run === undefined) return false;

  run.cancelled = true;
  run.controller.abort();
  return true;
}

export function endRun(run_id: string): void {
  runs.delete(run_id);
}

/** Tests only; the registry is process-global by design. */
export function resetRegistry(): void {
  runs.clear();
}
