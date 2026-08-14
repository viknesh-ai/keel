import type { ServerResponse } from "node:http";
import { problem } from "./http.js";
import { type Actor, sameActor } from "./ownership.js";
import { getRun, subscribe } from "./registry.js";
import { encodeFrame, framesAfter, KEEPALIVE, SSE_HEADERS } from "./sse.js";

/**
 * `GET /rt/v1/runs/{id}/stream` — reattach to a run already in flight
 * (doc 05 §E6).
 *
 * This is what makes an approval survive a page reload. The frames are recorded
 * as they are published, so replaying them re-raises the pending `INTERRUPT`
 * and the card comes back on its own. No separate "restore the approval" API,
 * no second source of truth about what the run has said.
 */

export function handleReattach(
  res: ServerResponse,
  input: {
    readonly runId: string;
    readonly actor: Actor;
    readonly lastEventId: string | null;
  },
): Promise<void> {
  const run = getRun(input.runId);
  // Who may reattach: this session, or a new session for the same identity
  // subject — the reload case. See ownership.ts for why anonymous cannot.
  if (run === undefined || !sameActor(run, input.actor)) {
    problem(res, 404, "no such run");
    return Promise.resolve();
  }

  res.writeHead(200, SSE_HEADERS);

  // Everything the run has said so far, or everything since the client's last
  // seen frame. A reload sends no Last-Event-ID and gets the whole transcript.
  for (const frame of framesAfter(run.frames, input.lastEventId)) {
    res.write(encodeFrame(frame));
  }

  return new Promise<void>((resolve) => {
    const keepalive = setInterval(() => res.write(KEEPALIVE), 15_000);
    const unsubscribe = subscribe(run, {
      write: (frame) => res.write(encodeFrame(frame)),
      close: () => finish(),
    });

    let done = false;
    function finish(): void {
      if (done) return;
      done = true;
      clearInterval(keepalive);
      unsubscribe();
      res.end();
      resolve();
    }

    // A reattached watcher leaving is not by itself a cancellation — the run
    // may still be suspended on an approval someone else will decide.
    res.on("close", finish);
  });
}
