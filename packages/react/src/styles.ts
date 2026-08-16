/**
 * Widget styles, as a string.
 *
 * Injected into a Shadow root rather than the document (doc 05 §E6: Shadow DOM
 * is non-negotiable). The widget lives inside someone else's product and must
 * not be broken by, or break, the host's CSS — a reset in the host that targets
 * `button` would otherwise reshape our controls, and our styles would leak into
 * theirs.
 *
 * Themed entirely through CSS custom properties the host can set, with defaults
 * that read as neutral rather than as "an AI product bolted on".
 */
export const WIDGET_STYLES = `
:host {
  --keel-bg: #ffffff;
  --keel-fg: #11151b;
  --keel-muted: #66717f;
  --keel-border: #d7dbe2;
  --keel-accent: #1f5fd0;
  --keel-accent-fg: #ffffff;
  --keel-radius: 8px;
  --keel-font: system-ui, -apple-system, "Segoe UI", sans-serif;
  --keel-duration: 150ms;

  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 2147483000;
  font-family: var(--keel-font);
  font-size: 14px;
  color: var(--keel-fg);
}

*, *::before, *::after { box-sizing: border-box; }

.k-sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}

button:focus-visible, input:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--keel-bg), 0 0 0 4px var(--keel-accent);
}

.k-widget__launcher {
  width: 48px; height: 48px; border-radius: 50%;
  border: 1px solid var(--keel-border);
  background: var(--keel-accent); color: var(--keel-accent-fg);
  font-size: 20px; cursor: pointer;
  transition: transform var(--keel-duration) ease-out;
}
.k-widget__launcher:hover { transform: translateY(-1px); }

.k-widget__panel {
  position: absolute; right: 0; bottom: 60px;
  display: flex; flex-direction: column;
  width: min(380px, calc(100vw - 40px));
  height: min(540px, calc(100vh - 120px));
  background: var(--keel-bg);
  border: 1px solid var(--keel-border);
  border-radius: var(--keel-radius);
  box-shadow: 0 8px 24px -4px rgb(0 0 0 / 0.12);
  overflow: hidden;
}

.k-widget__header { padding: 16px; border-bottom: 1px solid var(--keel-border); }
.k-widget__title { margin: 0; font-size: 15px; font-weight: 600; }
.k-widget__subtitle { margin: 4px 0 0; font-size: 12px; color: var(--keel-muted); }

.k-widget__messages { flex: 1; overflow-y: auto; padding: 16px; display: grid; gap: 12px; align-content: start; }
.k-widget__empty { text-align: center; color: var(--keel-muted); margin: auto 0; }
.k-widget__empty-title { margin: 0; font-weight: 600; color: var(--keel-fg); }
.k-widget__empty-body { margin: 4px 0 0; font-size: 12px; }

.k-msg { display: grid; gap: 2px; }
.k-msg__role { font-size: 11px; color: var(--keel-muted); }
.k-msg__text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.k-msg--user .k-msg__text { color: var(--keel-fg); }

/* Action affordances (doc 05 §E6). The widget carries its own rules for the
   card's classes because it is themed through --keel-* custom properties the
   host sets, not through the dashboard's token file. Same markup, same class
   contract, different surface. */
.k-widget__approval { padding: 0 16px 12px; }
.k-widget__approval-note { margin: 0; font-size: 12px; color: var(--keel-muted); }

.k-action__prose { margin: 0; }
.k-action {
  border: 1px solid var(--keel-border); border-radius: var(--keel-radius);
  padding: 12px; background: var(--keel-bg);
}
/* Weight, colour and fill all change. A destructive card that differed only in
   colour would be the same card to a user who cannot distinguish them. */
.k-action--destructive { border-width: 2px; border-color: #b3261e; background: #fdeceb; }

.k-action__facts { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 12px; }
.k-action__fact { display: contents; }
.k-action__fact dt { color: var(--keel-muted); text-transform: uppercase; letter-spacing: 0.04em; }
.k-action__fact dd { margin: 0; color: var(--keel-fg); }
.k-action__fact--consequence dd { font-weight: 600; color: #8c1d18; }

.k-action__controls { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.k-btn {
  height: 28px; padding: 0 12px; border-radius: 6px; cursor: pointer;
  font: inherit; border: 1px solid var(--keel-border); background: var(--keel-bg); color: var(--keel-fg);
}
.k-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.k-btn--primary { background: var(--keel-accent); color: var(--keel-accent-fg); border-color: transparent; }
.k-btn--danger { background: #b3261e; color: #ffffff; border-color: transparent; }

.k-widget__status { min-height: 20px; padding: 0 16px; font-size: 12px; color: var(--keel-muted); }
.k-widget__error { color: #b3261e; }

.k-widget__composer { display: flex; gap: 8px; padding: 12px 16px 16px; border-top: 1px solid var(--keel-border); }
.k-widget__input {
  flex: 1; height: 32px; padding: 0 8px;
  border: 1px solid var(--keel-border); border-radius: 6px;
  font: inherit; color: inherit; background: var(--keel-bg);
}
.k-widget__send, .k-widget__stop {
  height: 32px; padding: 0 12px; border-radius: 6px; cursor: pointer;
  border: 1px solid transparent; font: inherit;
}
.k-widget__send { background: var(--keel-accent); color: var(--keel-accent-fg); }
.k-widget__send:disabled { opacity: 0.5; cursor: not-allowed; }
.k-widget__stop { background: var(--keel-bg); color: var(--keel-fg); border-color: var(--keel-border); }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
`;
