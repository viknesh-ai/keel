import { randomUUID } from "node:crypto";
import type { Drive } from "./drive.js";

/**
 * The default driver: a realistic read-path sequence, used by the harness.
 *
 * A placeholder in one specific sense, stated plainly: it emits a scripted
 * AG-UI sequence rather than invoking the agent runtime. What is *not*
 * placeholder is everything the transport sessions claim — ordering, resume,
 * cancellation reaching the work, and now suspend-on-approval — because those
 * are properties of the server, and this driver only supplies something for
 * them to carry.
 */
export const scriptedDrive: Drive = async (run, message, emitEvent) => {
  emitEvent({ type: "RUN_STARTED", run_id: run.run_id });
  emitEvent({ type: "ACTIVITY", key: "resolving_intent", state: "started" });

  const callId = `call_${randomUUID().slice(0, 8)}`;
  emitEvent({ type: "TOOL_CALL_START", call_id: callId, tool: "list_customers" });
  emitEvent({ type: "ACTIVITY", key: "searching_customers", state: "started" });

  await new Promise((r) => setTimeout(r, 10));
  if (run.cancelled) return;

  emitEvent({ type: "TOOL_CALL_RESULT", call_id: callId, ok: true });
  emitEvent({ type: "TOOL_CALL_END", call_id: callId });
  emitEvent({ type: "ACTIVITY", key: "found_customers", state: "done", params: { count: 43 } });

  const messageId = `msg_${randomUUID().slice(0, 8)}`;
  emitEvent({ type: "TEXT_MESSAGE_START", message_id: messageId });

  for (const word of `Answering: ${message}`.split(" ")) {
    // Cancellation is checked between chunks, so a stop actually stops the work
    // rather than only closing the socket the tokens are travelling down.
    if (run.cancelled) return;
    await new Promise((r) => setTimeout(r, 5));
    emitEvent({ type: "TEXT_MESSAGE_CONTENT", message_id: messageId, delta: `${word} ` });
  }

  emitEvent({ type: "TEXT_MESSAGE_END", message_id: messageId });
  emitEvent({ type: "RUN_FINISHED", run_id: run.run_id, state: "Completed" });
};
