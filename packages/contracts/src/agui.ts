import type { EventType, PlatformEvent } from "./events.js";

/**
 * Mapping our platform events onto the AG-UI wire protocol (ADR-003).
 *
 * We adopt AG-UI rather than inventing a protocol: it is MIT, has ~16 event
 * types, and is implemented by Google, Microsoft, Amazon, Oracle, LangChain,
 * Mastra and PydanticAI. Competing with it would be pure loss.
 *
 * Three rules govern this file, and they are the whole point of it:
 *
 *  1. Not every platform event reaches a browser. Backend-facing events
 *     (knowledge sync, evaluation, budget) have `channel: "backend"` and are
 *     delivered by webhook and SSE-to-server only. Sending them to a widget
 *     would leak project-level operational detail to an end user of someone
 *     else's SaaS.
 *
 *  2. ACTIVITY is frontend-only and is never fed back to the model. Tool
 *     progress text is attacker-influenced in the MCP and OpenAPI cases, so
 *     routing it into model context would make status text an injection vector
 *     (doc 02 §4). This is a security property, not a UI preference.
 *
 *  3. REASONING_* is never emitted. AG-UI has the events and Crow's Message
 *     type carries a `thinking` field; we default both off (doc 06 §A3,
 *     ADR-018). Reasoning traces leak instructions and internal data, and are
 *     not a stable API. What developers need is the decision record, which is
 *     deterministic and inspectable — that is what the run-detail screen shows.
 */

/** The AG-UI event types we emit. REASONING_* is deliberately absent. */
export const AGUI_EVENT_TYPES = [
  "RUN_STARTED",
  "RUN_FINISHED",
  "RUN_ERROR",
  "TEXT_MESSAGE_START",
  "TEXT_MESSAGE_CONTENT",
  "TEXT_MESSAGE_END",
  "TOOL_CALL_START",
  "TOOL_CALL_ARGS",
  "TOOL_CALL_END",
  "TOOL_CALL_RESULT",
  "STATE_SNAPSHOT",
  "STATE_DELTA",
  "ACTIVITY",
  "INTERRUPT",
  "CUSTOM",
] as const;

export type AguiEventType = (typeof AGUI_EVENT_TYPES)[number];

/**
 * Where an event is allowed to go.
 *
 * `client`  — safe for the browser; mapped onto an AG-UI event.
 * `both`    — delivered to the browser *and* to webhooks.
 * `backend` — webhook and server-side SSE only. Never sent to a widget.
 */
export type EventChannel = "client" | "both" | "backend";

export type AguiMapping = {
  readonly agui: AguiEventType | null;
  readonly channel: EventChannel;
  /**
   * Whether the payload may be included in subsequent model context.
   * False for anything carrying attacker-influenceable free text.
   */
  readonly feedsModelContext: boolean;
  readonly note: string;
};

/**
 * Exhaustive by construction: `Record<EventType, …>` means adding a platform
 * event without deciding its channel is a type error, not an oversight that
 * silently defaults to "send it to the browser".
 */
export const AGUI_MAPPING: Record<EventType, AguiMapping> = {
  "conversation.created": {
    agui: null,
    channel: "backend",
    feedsModelContext: false,
    note: "Lifecycle bookkeeping. The client already knows it created a conversation.",
  },
  "message.created": {
    agui: "TEXT_MESSAGE_START",
    channel: "both",
    feedsModelContext: true,
    note: "Assistant prose streams as TEXT_MESSAGE_START/CONTENT/END. The message log is model context by definition.",
  },
  "run.started": {
    agui: "RUN_STARTED",
    channel: "both",
    feedsModelContext: false,
    note: "",
  },
  "run.completed": {
    agui: "RUN_FINISHED",
    channel: "both",
    feedsModelContext: false,
    note: "Cost and token counts are stripped before the client copy — they are project economics, not end-user data.",
  },
  "run.failed": {
    agui: "RUN_ERROR",
    channel: "both",
    feedsModelContext: false,
    note: "The client receives the error class and a typed user-facing framing, never the operator message.",
  },
  "run.cancelled": {
    agui: "RUN_FINISHED",
    channel: "both",
    feedsModelContext: false,
    note: "Cancellation is a normal terminal state, not an error.",
  },
  "tool.started": {
    agui: "TOOL_CALL_START",
    channel: "both",
    feedsModelContext: false,
    note: "",
  },
  "tool.completed": {
    agui: "TOOL_CALL_RESULT",
    channel: "both",
    feedsModelContext: true,
    note: "The tool result is what the model observes. Its integrity label travels with it — see integrity.ts.",
  },
  "tool.failed": {
    agui: "TOOL_CALL_END",
    channel: "both",
    feedsModelContext: true,
    note: "The model sees the typed error class so it can re-plan; it does not see the operator message.",
  },
  "approval.requested": {
    agui: "INTERRUPT",
    channel: "both",
    feedsModelContext: false,
    note: "INTERRUPT is why AG-UI fits: the approval flow maps onto a protocol event rather than a bolted-on side channel.",
  },
  "approval.decided": {
    agui: "STATE_DELTA",
    channel: "both",
    feedsModelContext: false,
    note: "The decision resolves the interrupt. JSON Patch against the run state.",
  },
  "approval.expired": {
    agui: "STATE_DELTA",
    channel: "both",
    feedsModelContext: false,
    note: "",
  },
  "workflow.started": {
    agui: "STATE_SNAPSHOT",
    channel: "both",
    feedsModelContext: false,
    note: "",
  },
  "workflow.node.completed": {
    agui: "STATE_DELTA",
    channel: "both",
    feedsModelContext: false,
    note: "Node-level progress as JSON Patch, so a client can render the graph advancing without refetching.",
  },
  "workflow.completed": {
    agui: "STATE_DELTA",
    channel: "both",
    feedsModelContext: false,
    note: "",
  },
  "workflow.failed": {
    agui: "RUN_ERROR",
    channel: "both",
    feedsModelContext: false,
    note: "",
  },
  "knowledge.sync.started": {
    agui: null,
    channel: "backend",
    feedsModelContext: false,
    note: "Project operations. An end user of the customer's SaaS has no business seeing ingestion state.",
  },
  "knowledge.sync.completed": {
    agui: null,
    channel: "backend",
    feedsModelContext: false,
    note: "Document counts describe the customer's corpus. Backend only.",
  },
  "knowledge.sync.failed": {
    agui: null,
    channel: "backend",
    feedsModelContext: false,
    note: "Backend only.",
  },
  "policy.denied": {
    agui: "ACTIVITY",
    channel: "both",
    feedsModelContext: false,
    note: "The user is told plainly that something was not permitted, generated from the typed decision. The rule id and reason go to the webhook copy only.",
  },
  "budget.exhausted": {
    agui: null,
    channel: "backend",
    feedsModelContext: false,
    note: "Budgets are project economics. The user sees the resulting AgentLimitError framing, not the numbers.",
  },
  "evaluation.completed": {
    agui: null,
    channel: "backend",
    feedsModelContext: false,
    note: "CI and dashboard concern. Never client-facing.",
  },
  "security.signal": {
    agui: null,
    channel: "backend",
    feedsModelContext: false,
    note: "Telling an attacker their injection was detected helps them iterate. Backend only, high severity, always logged.",
  },
};

export function mappingFor(type: EventType): AguiMapping {
  return AGUI_MAPPING[type];
}

/** True when the event may be delivered over an AG-UI stream to a browser. */
export function isClientVisible(type: EventType): boolean {
  const { channel } = AGUI_MAPPING[type];
  return channel === "client" || channel === "both";
}

/**
 * True when the event's payload may be included in later model context.
 *
 * The runtime asks this before appending anything to a prompt. ACTIVITY text
 * never qualifies, which is what stops tool progress strings from becoming an
 * injection vector.
 */
export function feedsModelContext(type: EventType): boolean {
  return AGUI_MAPPING[type].feedsModelContext;
}

/** Filters a platform event stream down to what a widget is allowed to see. */
export function clientVisibleEvents(events: readonly PlatformEvent[]): readonly PlatformEvent[] {
  return events.filter((event) => isClientVisible(event.type));
}

/**
 * Frontend-only progress. Emitted by `ctx.progress()` inside a tool and by the
 * runtime for retrieval and planning phases.
 *
 * Renders as `Searching customers…` → `✓ Found 43`. Never `Thinking…`, and
 * never streamed model reasoning (doc 05 §E6).
 */
export type ActivityEvent = {
  readonly type: "ACTIVITY";
  readonly run_id: string;
  readonly step_id?: string;
  /** Localisation key. No user-visible string literals in components. */
  readonly key: string;
  readonly params?: Readonly<Record<string, string | number>>;
  readonly state: "started" | "progress" | "done" | "failed";
};

export function activity(
  run_id: string,
  key: string,
  state: ActivityEvent["state"],
  params?: Readonly<Record<string, string | number>>,
): ActivityEvent {
  return params === undefined
    ? { type: "ACTIVITY", run_id, key, state }
    : { type: "ACTIVITY", run_id, key, state, params };
}
