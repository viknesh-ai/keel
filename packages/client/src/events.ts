/**
 * The AG-UI event surface the client exposes (ADR-003, packages/contracts/agui.ts).
 *
 * Deliberately a closed union rather than a bag of strings: a handler for an
 * event that does not exist is a compile error, and adding a server event
 * without deciding how a client renders it does not silently type-check.
 */

export type AguiEvent =
  | { readonly type: "RUN_STARTED"; readonly run_id: string }
  | { readonly type: "RUN_FINISHED"; readonly run_id: string; readonly state: string }
  | {
      readonly type: "RUN_ERROR";
      readonly run_id: string;
      readonly error_class: string;
      readonly message: string;
    }
  | { readonly type: "TEXT_MESSAGE_START"; readonly message_id: string }
  | { readonly type: "TEXT_MESSAGE_CONTENT"; readonly message_id: string; readonly delta: string }
  | { readonly type: "TEXT_MESSAGE_END"; readonly message_id: string }
  | { readonly type: "TOOL_CALL_START"; readonly call_id: string; readonly tool: string }
  | { readonly type: "TOOL_CALL_END"; readonly call_id: string }
  | { readonly type: "TOOL_CALL_RESULT"; readonly call_id: string; readonly ok: boolean }
  | { readonly type: "STATE_DELTA"; readonly patch: readonly unknown[] }
  | { readonly type: "STATE_SNAPSHOT"; readonly state: unknown }
  /** Frontend-only status. Never fed back to the model — see contracts/agui.ts. */
  | {
      readonly type: "ACTIVITY";
      readonly key: string;
      readonly state: string;
      readonly params?: Record<string, unknown>;
    }
  /**
   * A run parked on a human decision (doc 03 §C4).
   *
   * The four facts travel with the event because the card must be able to state
   * the consequence, and a client that has to fetch them separately will render
   * a "Yes/No" while it waits — which is the exact affordance the design forbids.
   */
  | {
      readonly type: "INTERRUPT";
      readonly approval_id: string;
      readonly tool: string;
      readonly mode: string;
      readonly risk?: string;
      readonly action?: string;
      readonly resource?: string;
      readonly consequence?: string;
      readonly cost?: string;
    }
  | { readonly type: "CUSTOM"; readonly name: string; readonly payload: unknown };

export type AguiEventType = AguiEvent["type"];
export type EventOf<T extends AguiEventType> = Extract<AguiEvent, { type: T }>;

export type Handler<T extends AguiEventType> = (event: EventOf<T>) => void;

/** Minimal typed emitter. No dependency, and small enough to stay in budget. */
export class Emitter {
  readonly #handlers = new Map<string, Set<(event: AguiEvent) => void>>();

  on<T extends AguiEventType>(type: T, handler: Handler<T>): () => void {
    const set = this.#handlers.get(type) ?? new Set();
    set.add(handler as (event: AguiEvent) => void);
    this.#handlers.set(type, set);
    return () => set.delete(handler as (event: AguiEvent) => void);
  }

  /** Every event, for logging and for the trace view. */
  onAny(handler: (event: AguiEvent) => void): () => void {
    return this.on("*" as AguiEventType, handler as Handler<AguiEventType>);
  }

  emit(event: AguiEvent): void {
    for (const handler of this.#handlers.get(event.type) ?? []) {
      // A throwing handler must not break the stream for every other handler,
      // or one bad renderer takes the whole conversation down.
      try {
        handler(event);
      } catch {
        // Swallowed deliberately; the transport is not the place to decide what
        // a UI bug means.
      }
    }
    for (const handler of this.#handlers.get("*") ?? []) {
      try {
        handler(event);
      } catch {
        /* as above */
      }
    }
  }

  clear(): void {
    this.#handlers.clear();
  }
}
