import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { WIDGET_STYLES } from "./styles.js";

/**
 * Renders children into a Shadow root (doc 05 §E6).
 *
 * `mode: "open"` deliberately: closed mode would stop the host debugging its own
 * page, and it buys nothing — the isolation that matters is CSS, and open shadow
 * roots isolate styles just as completely.
 */
export function ShadowRoot({ children }: { readonly children: ReactNode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<globalThis.ShadowRoot | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null || host.shadowRoot !== null) return;

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = WIDGET_STYLES;
    shadow.append(style);
    setRoot(shadow);
  }, []);

  return (
    <div ref={hostRef} data-keel-widget="">
      {root === null ? null : createPortal(children, root as unknown as Element)}
    </div>
  );
}
