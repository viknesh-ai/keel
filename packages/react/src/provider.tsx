import { type AguiEvent, type ClientTool, type IdentityProvider, KeelClient } from "@keel/client";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createTranslator, type Locale, type Translate } from "./i18n.js";

/**
 * KeelProvider (doc 05 Part B).
 *
 * Holds one client for the tree and exposes the conversation as state. There is
 * no `userId` prop and there never will be: identity is a function returning a
 * freshly minted token, because a client-supplied user id is not an identity
 * (doc 03 §B1).
 */

export type Message = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly streaming: boolean;
};

export type Activity = { readonly key: string; readonly params?: Record<string, unknown> };

/**
 * A pending approval, as the widget knows it.
 *
 * `decidable` is false for `approve` mode: someone else has to answer, and
 * showing this user two buttons that will be refused is worse than telling them
 * what is actually happening.
 */
export type PendingApproval = {
  readonly id: string;
  readonly tool: string;
  readonly decidable: boolean;
  readonly risk: string;
  readonly action?: string;
  readonly resource?: string;
  readonly consequence?: string;
  readonly cost?: string;
};

export type KeelContextValue = {
  readonly messages: readonly Message[];
  readonly activity: Activity | null;
  readonly running: boolean;
  readonly error: string | null;
  readonly approval: PendingApproval | null;
  readonly deciding: boolean;
  readonly t: Translate;
  send(text: string): Promise<void>;
  stop(): void;
  decide(decision: "approved" | "rejected"): Promise<void>;
};

const KeelContext = createContext<KeelContextValue | null>(null);

export function useKeel(): KeelContextValue {
  const value = useContext(KeelContext);
  if (value === null) throw new Error("useKeel must be used inside <KeelProvider>");
  return value;
}

export type KeelProviderProps = {
  readonly endpoint: string;
  readonly projectId: string;
  readonly identity: IdentityProvider;
  readonly tools?: readonly ClientTool[];
  readonly locale?: Locale;
  readonly children: ReactNode;
};

export function KeelProvider({
  endpoint,
  projectId,
  identity,
  tools,
  locale = "en",
  children,
}: KeelProviderProps) {
  const [messages, setMessages] = useState<readonly Message[]>([]);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [deciding, setDeciding] = useState(false);

  const runIdRef = useRef<string | null>(null);
  const conversationRef = useRef<string | null>(null);
  const t = useMemo(() => createTranslator(locale), [locale]);

  const client = useMemo(
    () => new KeelClient({ endpoint, projectId, identity }),
    [endpoint, projectId, identity],
  );

  useEffect(() => {
    for (const tool of tools ?? []) client.registerTool(tool);
  }, [client, tools]);

  const handle = useCallback(
    (event: AguiEvent) => {
      switch (event.type) {
        case "CUSTOM":
          if (event.name === "run.id") {
            const runId = (event.payload as { run_id: string }).run_id;
            runIdRef.current = runId;
            // Remembered so a reload can reattach. sessionStorage, not local:
            // the run belongs to this tab's visit, and an id left behind for
            // the next person to use the browser is not something to persist.
            rememberRun(runId);
          }
          break;

        case "INTERRUPT":
          setApproval({
            id: event.approval_id,
            tool: event.tool,
            decidable: event.mode !== "approve",
            risk: event.risk ?? "high",
            ...(event.action === undefined ? {} : { action: event.action }),
            ...(event.resource === undefined ? {} : { resource: event.resource }),
            ...(event.consequence === undefined ? {} : { consequence: event.consequence }),
            ...(event.cost === undefined ? {} : { cost: event.cost }),
          });
          break;

        case "TEXT_MESSAGE_START":
          setMessages((current) => [
            ...current,
            { id: event.message_id, role: "assistant", text: "", streaming: true },
          ]);
          break;

        case "TEXT_MESSAGE_CONTENT":
          setMessages((current) =>
            current.map((m) =>
              m.id === event.message_id ? { ...m, text: m.text + event.delta } : m,
            ),
          );
          break;

        case "TEXT_MESSAGE_END":
          setMessages((current) =>
            current.map((m) => (m.id === event.message_id ? { ...m, streaming: false } : m)),
          );
          break;

        // Status, never reasoning. ACTIVITY is frontend-only by design and is
        // the whole reason the widget can say "Searching customers…" instead of
        // "Thinking…" (doc 05 §E6).
        case "ACTIVITY":
          setActivity(
            event.state === "done" && event.params === undefined
              ? null
              : { key: event.key, ...(event.params === undefined ? {} : { params: event.params }) },
          );
          break;

        case "RUN_ERROR":
          setError(t("run.failed"));
          setRunning(false);
          setActivity(null);
          setApproval(null);
          forgetRun();
          break;

        case "RUN_FINISHED":
          setRunning(false);
          setActivity(null);
          setApproval(null);
          forgetRun();
          setMessages((current) => current.map((m) => ({ ...m, streaming: false })));
          break;

        default:
          break;
      }
    },
    [t],
  );

  useEffect(() => client.onAny(handle), [client, handle]);

  const send = useCallback(
    async (text: string) => {
      if (text.trim() === "" || running) return;

      setError(null);
      setRunning(true);
      setMessages((current) => [
        ...current,
        { id: `local_${current.length}`, role: "user", text, streaming: false },
      ]);

      try {
        if (conversationRef.current === null) {
          conversationRef.current = (await client.createConversation()).id;
        }
        await client.run(conversationRef.current, text);
      } catch {
        setError(t("run.failed"));
      } finally {
        setRunning(false);
        setActivity(null);
      }
    },
    [client, running, t],
  );

  /**
   * Answers a pending approval.
   *
   * The card stays on screen until the server has taken the decision. Clearing
   * it optimistically would tell the user their answer landed when it may have
   * been refused — and for a destructive action that is the wrong way round.
   */
  const decide = useCallback(
    async (decision: "approved" | "rejected") => {
      const pending = approval;
      if (pending === null || deciding) return;

      setDeciding(true);
      try {
        await client.decide(pending.id, decision);
        setApproval(null);
      } catch {
        setError(t("approval.failed"));
      } finally {
        setDeciding(false);
      }
    },
    [approval, client, deciding, t],
  );

  // Reattach on mount. This is what makes an approval survive a reload: the
  // server replays what the run has said, the INTERRUPT arrives again, and the
  // card comes back without a restore API of its own.
  useEffect(() => {
    const runId = rememberedRun();
    if (runId === null) return;

    let live = true;
    void client
      .reattach(runId)
      .catch(() => {
        // The run finished, expired, or belongs to someone else. Nothing to
        // restore, and nothing worth interrupting the user about.
        forgetRun();
      })
      .finally(() => {
        if (live) setRunning(false);
      });

    setRunning(true);
    return () => {
      live = false;
    };
  }, [client]);

  const stop = useCallback(() => {
    const runId = runIdRef.current;
    if (runId !== null) void client.cancel(runId);
    setRunning(false);
    setActivity(null);
    setApproval(null);
    forgetRun();
  }, [client]);

  const value = useMemo<KeelContextValue>(
    () => ({ messages, activity, running, error, approval, deciding, t, send, stop, decide }),
    [messages, activity, running, error, approval, deciding, t, send, stop, decide],
  );

  return <KeelContext.Provider value={value}>{children}</KeelContext.Provider>;
}

/* --------------------------------------------------------- run memory -- */

const RUN_KEY = "keel.run";

/** Storage is absent in SSR and in some embedded contexts; never assume it. */
function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    // Blocked by a cookie policy. A widget that throws on load because it could
    // not remember a run id would be worse than one that simply forgets.
    return null;
  }
}

function rememberRun(runId: string): void {
  storage()?.setItem(RUN_KEY, runId);
}

function rememberedRun(): string | null {
  return storage()?.getItem(RUN_KEY) ?? null;
}

function forgetRun(): void {
  storage()?.removeItem(RUN_KEY);
}
