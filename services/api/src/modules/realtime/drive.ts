import type { ApprovalDecision } from "./approval-waits.js";
import type { AguiEvent } from "./events.js";
import type { LiveRun } from "./registry.js";

/**
 * What a driver is handed to suspend a run on a human decision.
 *
 * `requestApproval` emits the AG-UI `INTERRUPT` and then blocks. That it is a
 * protocol event rather than a side channel is the reason AG-UI was chosen
 * (doc 05 Part A): the client already knows how to render an interrupt, so a
 * suspended run looks like part of the stream instead of a special case bolted
 * onto it.
 */
export type DriveContext = {
  readonly requestApproval: (input: {
    readonly approvalId: string;
    readonly tool: string;
    readonly mode: "confirm" | "approve";
    readonly timeoutMs?: number;
  }) => Promise<ApprovalDecision>;
};

/** Drives one run, emitting events. Replaced with the agent runtime later. */
export type Drive = (
  run: LiveRun,
  message: string,
  emitEvent: (e: AguiEvent) => void,
  ctx: DriveContext,
) => Promise<void>;
