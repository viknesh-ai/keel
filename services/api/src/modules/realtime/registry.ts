import type { AguiEvent } from "./events.js";
import type { SseFrame } from "./sse.js";

/**
 * In-process registry of live runs.
 *
 * Holds the cancellation signal, the frames emitted so far and whoever is
 * currently watching, so that a reconnecting client can resume and a cancel can
 * reach the work rather than only closing the socket.
 *
 * In-process is correct for a single deployable (ADR-001) and explicitly not
 * correct once workers are distributed — at which point cancellation moves to
 * Redis and this becomes a cache over it. Naming that now so the boundary is
 * visible rather than discovered.
 */

export type Subscriber = {
  readonly write: (frame: SseFrame) => void;
  readonly close: () => void;
};

export type LiveRun = {
  readonly run_id: string;
  readonly session_id: string;
  /** The identity subject, when the session had one. Anonymous runs have none. */
  readonly subject: string | null;
  readonly controller: AbortController;
  readonly frames: SseFrame[];
  readonly subscribers: Set<Subscriber>;
  cancelled: boolean;
  /** True while the run is parked on a human decision rather than working. */
  suspended: boolean;
  nextId: number;
};

const runs = new Map<string, LiveRun>();

export function startRun(
  run_id: string,
  session_id: string,
  subject: string | null = null,
): LiveRun {
  const run: LiveRun = {
    run_id,
    session_id,
    subject,
    controller: new AbortController(),
    frames: [],
    subscribers: new Set(),
    cancelled: false,
    suspended: false,
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
 * Records an event and sends it to everyone currently watching.
 *
 * Recording happens whether or not anyone is listening. That is what lets a
 * reattaching client replay the run — including an `INTERRUPT` raised while the
 * browser was being reloaded.
 */
export function publish(run: LiveRun, event: AguiEvent): SseFrame {
  const frame = emit(run, event);
  for (const subscriber of run.subscribers) subscriber.write(frame);
  return frame;
}

export function subscribe(run: LiveRun, subscriber: Subscriber): () => void {
  run.subscribers.add(subscriber);
  return () => run.subscribers.delete(subscriber);
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
  const run = runs.get(run_id);
  // Everyone watching is told the run is over. Without this a reattached
  // connection would hang open on a run that finished on someone else's socket.
  if (run !== undefined) for (const subscriber of run.subscribers) subscriber.close();
  runs.delete(run_id);
}

/** Tests only; the registry is process-global by design. */
export function resetRegistry(): void {
  for (const run of runs.values()) for (const subscriber of run.subscribers) subscriber.close();
  runs.clear();
}
