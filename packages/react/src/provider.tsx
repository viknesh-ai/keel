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

export type KeelContextValue = {
  readonly messages: readonly Message[];
  readonly activity: Activity | null;
  readonly running: boolean;
  readonly error: string | null;
  readonly t: Translate;
  send(text: string): Promise<void>;
  stop(): void;
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
            runIdRef.current = (event.payload as { run_id: string }).run_id;
          }
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
          break;

        case "RUN_FINISHED":
          setRunning(false);
          setActivity(null);
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

  const stop = useCallback(() => {
    const runId = runIdRef.current;
    if (runId !== null) void client.cancel(runId);
    setRunning(false);
    setActivity(null);
  }, [client]);

  const value = useMemo<KeelContextValue>(
    () => ({ messages, activity, running, error, t, send, stop }),
    [messages, activity, running, error, t, send, stop],
  );

  return <KeelContext.Provider value={value}>{children}</KeelContext.Provider>;
}
