/**
 * i18n scaffolding (doc 05 §E6).
 *
 * No user-visible string literal appears inside a component. Every one goes
 * through `t()`, so adding a locale is a data change rather than a hunt through
 * JSX — and the UI locale stays independent of the language the agent replies
 * in, which is a separate setting entirely.
 *
 * Deliberately tiny: a translation library would cost more bundle than the whole
 * widget budget allows, and the widget's string set is small and closed.
 */

export type Locale = "en";

export const STRINGS = {
  en: {
    "launcher.open": "Open assistant",
    "launcher.close": "Close assistant",
    "panel.title": "Assistant",
    "panel.subtitle": "Ask about customers, invoices and orders.",
    "composer.placeholder": "Ask a question…",
    "composer.send": "Send",
    "composer.label": "Your question",
    "run.stop": "Stop",
    "run.stopped": "Stopped.",
    "run.failed": "That request could not be completed.",
    "message.you": "You",
    "message.assistant": "Assistant",
    "empty.title": "Nothing asked yet",
    "empty.body": "Try: customers who haven't logged in for 30 days.",
    "activity.resolving_intent": "Working out what you need…",
    "activity.searching_customers": "Searching customers…",
    "activity.found_customers": "Found {count}",
    "activity.retrieving": "Reading documentation…",
    "activity.default": "Working…",
    "approval.action": "Action",
    "approval.resource": "Affects",
    "approval.consequence": "Cannot be undone",
    "approval.cost": "Cost",
    "approval.approve": "Approve",
    "approval.reject": "Reject",
    "approval.pending": "Sending…",
    "approval.fallback": "Run {tool}",
    "approval.elsewhere": "Waiting for an approver.",
    "approval.failed": "That decision could not be recorded.",
    "a11y.approval": "Approval required",
    "a11y.messages": "Conversation",
    "a11y.activity": "Assistant status",
  },
} as const satisfies Record<Locale, Record<string, string>>;

export type StringKey = keyof (typeof STRINGS)["en"];

export type Translate = (key: StringKey, params?: Record<string, string | number>) => string;

export function createTranslator(locale: Locale = "en"): Translate {
  const table = STRINGS[locale] ?? STRINGS.en;

  return (key, params) => {
    const template: string = table[key] ?? STRINGS.en[key] ?? key;
    if (params === undefined) return template;

    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match,
    );
  };
}

/**
 * Maps an ACTIVITY key onto a status string.
 *
 * Falls back to a generic "Working…" rather than rendering the raw key: a key
 * the widget does not recognise is a server that shipped ahead of the client,
 * and showing `searching_customers_v2` to a user is worse than showing nothing
 * specific.
 */
export function activityLabel(
  t: Translate,
  key: string,
  params?: Record<string, string | number>,
): string {
  const candidate = `activity.${key}` as StringKey;
  return candidate in STRINGS.en ? t(candidate, params) : t("activity.default");
}
