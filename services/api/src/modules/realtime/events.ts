/** The AG-UI events the server emits. Mirrors packages/client/src/events.ts. */
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
