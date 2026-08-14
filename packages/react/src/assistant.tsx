import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { activityLabel } from "./i18n.js";
import { useKeel } from "./provider.js";

/**
 * The embedded assistant (doc 05 §E6).
 *
 * Accessibility here is not a polish pass — the panel is a modal surface inside
 * someone else's product, and getting it wrong traps a keyboard user in a page
 * they cannot leave. So: focus moves into the panel on open and returns to the
 * launcher on close, Escape closes, Tab is trapped while open, and streaming
 * text is announced politely rather than per token.
 */

export function Assistant() {
  const { messages, activity, running, error, t, send, stop } = useKeel();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");

  const panelRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const titleId = useId();
  const inputId = useId();

  // Focus enters the panel on open and returns to the launcher on close.
  //
  // `wasOpen` matters more than it looks: without it the close branch also runs
  // on first render and the widget grabs focus the moment the host page loads.
  // A widget embedded in someone else's product must never do that — the user
  // was probably typing somewhere else.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      inputRef.current?.focus();
      return;
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      launcherRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        return;
      }

      if (event.key !== "Tab") return;

      // Trap Tab inside the panel. A modal that lets focus escape into the host
      // page is worse than no modal, because the user cannot tell where they are.
      const panel = panelRef.current;
      if (panel === null) return;

      const focusable = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  // Keyed on the transcript's length *and* the trailing text, because streaming
  // appends into the last message without adding one — depending on length
  // alone would leave the view stuck while an answer is still arriving.
  const transcriptTail = `${messages.length}:${messages.at(-1)?.text.length ?? 0}`;
  // transcriptTail is a trigger, not a value this effect reads: it exists so the
  // view follows a streaming answer, and removing it would freeze the scroll
  // position mid-response.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger dependency
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [transcriptTail]);

  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const text = draft;
      setDraft("");
      void send(text);
    },
    [draft, send],
  );

  return (
    <div className="k-widget">
      <button
        ref={launcherRef}
        type="button"
        className="k-widget__launcher"
        aria-expanded={open}
        aria-label={open ? t("launcher.close") : t("launcher.open")}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">{open ? "×" : "?"}</span>
      </button>

      {open ? (
        <div
          ref={panelRef}
          className="k-widget__panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
        >
          <header className="k-widget__header">
            <h2 id={titleId} className="k-widget__title">
              {t("panel.title")}
            </h2>
            <p className="k-widget__subtitle">{t("panel.subtitle")}</p>
          </header>

          <div
            ref={listRef}
            className="k-widget__messages"
            // role="log" is the correct role for a sequential transcript, and
            // unlike a bare div it actually supports the live-region props.
            // Polite and on the container rather than per chunk: announcing
            // every token would make a screen reader unusable during streaming.
            role="log"
            aria-live="polite"
            aria-atomic="false"
            aria-label={t("a11y.messages")}
          >
            {messages.length === 0 ? (
              <div className="k-widget__empty">
                <p className="k-widget__empty-title">{t("empty.title")}</p>
                <p className="k-widget__empty-body">{t("empty.body")}</p>
              </div>
            ) : null}

            {messages.map((message) => (
              <div key={message.id} className={`k-msg k-msg--${message.role}`}>
                <span className="k-msg__role">
                  {message.role === "user" ? t("message.you") : t("message.assistant")}
                </span>
                <p className="k-msg__text">{message.text}</p>
              </div>
            ))}
          </div>

          {/* Status, not a spinner. Never "Thinking…", never model reasoning. */}
          {/* role="status" carries an implicit aria-live="polite" and, unlike a
              bare div, supports being labelled. */}
          <div className="k-widget__status" role="status" aria-label={t("a11y.activity")}>
            {activity === null
              ? null
              : activityLabel(
                  t,
                  activity.key,
                  activity.params as Record<string, string | number> | undefined,
                )}
            {error === null ? null : <span className="k-widget__error">{error}</span>}
          </div>

          <form className="k-widget__composer" onSubmit={submit}>
            <label className="k-sr-only" htmlFor={inputId}>
              {t("composer.label")}
            </label>
            <input
              ref={inputRef}
              id={inputId}
              className="k-widget__input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t("composer.placeholder")}
              autoComplete="off"
              disabled={running}
            />
            {/* Stop is always available while a run is active, and it actually
                cancels the tool call rather than only hiding the output. */}
            {running ? (
              <button type="button" className="k-widget__stop" onClick={stop}>
                {t("run.stop")}
              </button>
            ) : (
              <button type="submit" className="k-widget__send" disabled={draft.trim() === ""}>
                {t("composer.send")}
              </button>
            )}
          </form>
        </div>
      ) : null}
    </div>
  );
}
