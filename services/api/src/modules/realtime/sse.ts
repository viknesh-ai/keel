import type { AguiEvent } from "./events.js";

/**
 * Server-sent events for the AG-UI stream (doc 05 Part A).
 *
 * Written here rather than taken from a library because the framing has to
 * interact correctly with three things at once: resume-from-last-event-id,
 * cancellation reaching the worker, and a keep-alive that does not look like an
 * event to the client.
 */

export type SseFrame = { readonly id: number; readonly event: AguiEvent };

/** One frame. `id` is monotonic per run, which is what makes resume meaningful. */
export function encodeFrame(frame: SseFrame): string {
  return `id: ${frame.id}\ndata: ${JSON.stringify(frame.event)}\n\n`;
}

/**
 * A comment line. SSE clients ignore it, so it keeps proxies from closing an
 * idle connection without the client seeing a spurious event.
 */
export const KEEPALIVE = ": keep-alive\n\n";

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Nginx buffers text/event-stream by default, which turns a live stream into
  // one delivery at the end. This is the header that stops it.
  "x-accel-buffering": "no",
};

/**
 * Replays the frames a reconnecting client has not seen.
 *
 * Resume rather than restart: a client that dropped after 40 events should not
 * receive them again, both because re-rendering them is wrong and because the
 * run is not re-executed — the frames come from the recorded step log.
 */
export function framesAfter(
  frames: readonly SseFrame[],
  lastEventId: string | null,
): readonly SseFrame[] {
  if (lastEventId === null) return frames;

  const last = Number(lastEventId);
  if (!Number.isInteger(last)) return frames;

  return frames.filter((frame) => frame.id > last);
}
