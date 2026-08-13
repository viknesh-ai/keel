/**
 * Design tokens — docs/architecture/05 §E2.
 *
 * Declared as data first and emitted to CSS second, so the contrast check in
 * test/contrast.test.ts can reason about the *same* values the stylesheet ships.
 * A token matrix that is only expressed as CSS cannot be verified, and doc 05
 * requires CI to prove a theme tweak has not silently broken WCAG AA.
 *
 * Semantic names only. No component may reference a raw colour.
 */

export type ThemeName = "dark" | "light";

/** Every semantic colour token. Adding one here forces both themes to define it. */
export type ColorToken =
  | "bg-canvas"
  | "bg-surface"
  | "bg-raised"
  | "bg-inset"
  | "bg-hover"
  | "bg-active"
  | "bg-selected"
  | "text-primary"
  | "text-secondary"
  | "text-tertiary"
  | "text-inverse"
  | "text-link"
  | "border-subtle"
  | "border-default"
  | "border-strong"
  | "border-focus"
  | "accent-bg"
  | "accent-bg-hover"
  | "accent-text"
  | "accent-subtle-bg"
  | "accent-subtle-text"
  | "success-bg"
  | "success-text"
  | "success-subtle-bg"
  | "success-subtle-text"
  | "warning-bg"
  | "warning-text"
  | "warning-subtle-bg"
  | "warning-subtle-text"
  | "danger-bg"
  | "danger-bg-hover"
  | "danger-text"
  | "danger-subtle-bg"
  | "danger-subtle-text"
  | "info-subtle-bg"
  | "info-subtle-text";

export type Palette = Record<ColorToken, string>;

/**
 * Dark is the default: this is a developer tool people stare at (doc 05 §E2).
 * Neutrals are a cool grey ramp; one accent (blue) carries all interaction.
 */
export const DARK: Palette = {
  "bg-canvas": "#0b0d10",
  "bg-surface": "#12151a",
  "bg-raised": "#181c22",
  "bg-inset": "#0e1114",
  "bg-hover": "#1d222a",
  "bg-active": "#232933",
  "bg-selected": "#16233a",

  "text-primary": "#e8ecf2",
  "text-secondary": "#a3adbb",
  "text-tertiary": "#7c8797",
  "text-inverse": "#0b0d10",
  "text-link": "#6ea8fe",

  "border-subtle": "#1c2129",
  "border-default": "#272d37",
  "border-strong": "#606c7e",
  "border-focus": "#4d9bff",

  "accent-bg": "#2f6fed",
  "accent-bg-hover": "#2b66dc",
  "accent-text": "#ffffff",
  "accent-subtle-bg": "#12213c",
  "accent-subtle-text": "#8cb8ff",

  "success-bg": "#1a7f4b",
  "success-text": "#ffffff",
  "success-subtle-bg": "#0e2a1d",
  "success-subtle-text": "#5ed99a",

  "warning-bg": "#8a5a00",
  "warning-text": "#ffffff",
  "warning-subtle-bg": "#2b2008",
  "warning-subtle-text": "#e6b23c",

  "danger-bg": "#c0392f",
  "danger-bg-hover": "#c94136",
  "danger-text": "#ffffff",
  "danger-subtle-bg": "#2e1412",
  "danger-subtle-text": "#f18b80",

  "info-subtle-bg": "#12213c",
  "info-subtle-text": "#8cb8ff",
};

export const LIGHT: Palette = {
  "bg-canvas": "#f7f8fa",
  "bg-surface": "#ffffff",
  "bg-raised": "#ffffff",
  "bg-inset": "#f1f3f6",
  "bg-hover": "#eef0f4",
  "bg-active": "#e4e8ee",
  "bg-selected": "#e8f0ff",

  "text-primary": "#11151b",
  "text-secondary": "#4a5563",
  "text-tertiary": "#66717f",
  "text-inverse": "#ffffff",
  "text-link": "#1a56c4",

  "border-subtle": "#eaecf0",
  "border-default": "#d7dbe2",
  "border-strong": "#828b9c",
  "border-focus": "#1f6feb",

  "accent-bg": "#1f5fd0",
  "accent-bg-hover": "#1a53b8",
  "accent-text": "#ffffff",
  "accent-subtle-bg": "#e8f0ff",
  "accent-subtle-text": "#1a4fa8",

  "success-bg": "#12703f",
  "success-text": "#ffffff",
  "success-subtle-bg": "#e4f5ea",
  "success-subtle-text": "#116139",

  "warning-bg": "#8a5a00",
  "warning-text": "#ffffff",
  "warning-subtle-bg": "#fdf2d9",
  "warning-subtle-text": "#7a4f00",

  "danger-bg": "#b3261e",
  "danger-bg-hover": "#9c211a",
  "danger-text": "#ffffff",
  "danger-subtle-bg": "#fdeceb",
  "danger-subtle-text": "#9c211a",

  "info-subtle-bg": "#e8f0ff",
  "info-subtle-text": "#1a4fa8",
};

export const THEMES: Record<ThemeName, Palette> = { dark: DARK, light: LIGHT };

/**
 * Every foreground/background pair a component may actually render, with the
 * WCAG level it must clear.
 *
 * This list is the contract the CI contrast check enforces. If a component
 * introduces a new pairing it must be added here, which is the point: the check
 * can only protect pairs it knows about.
 *
 * `AA` = 4.5:1 for body text. `AA-large` = 3:1, permitted only for text at
 * 20px+ or bold 16px+, and for the non-text boundaries (borders, focus ring)
 * that WCAG 1.4.11 holds to the same 3:1.
 */
export type ContrastPair = {
  readonly fg: ColorToken;
  readonly bg: ColorToken;
  readonly level: "AA" | "AA-large";
  readonly usage: string;
};

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { fg: "text-primary", bg: "bg-canvas", level: "AA", usage: "body text on the page" },
  { fg: "text-primary", bg: "bg-surface", level: "AA", usage: "body text on a card" },
  { fg: "text-primary", bg: "bg-raised", level: "AA", usage: "body text in a popover" },
  { fg: "text-primary", bg: "bg-inset", level: "AA", usage: "body text in an input" },
  { fg: "text-primary", bg: "bg-hover", level: "AA", usage: "row text under the cursor" },
  { fg: "text-primary", bg: "bg-active", level: "AA", usage: "pressed control" },
  { fg: "text-primary", bg: "bg-selected", level: "AA", usage: "selected row" },

  { fg: "text-secondary", bg: "bg-canvas", level: "AA", usage: "secondary label" },
  { fg: "text-secondary", bg: "bg-surface", level: "AA", usage: "secondary label on a card" },
  { fg: "text-secondary", bg: "bg-raised", level: "AA", usage: "menu item description" },

  { fg: "text-tertiary", bg: "bg-canvas", level: "AA", usage: "placeholder, timestamps" },
  { fg: "text-tertiary", bg: "bg-surface", level: "AA", usage: "placeholder on a card" },

  { fg: "text-link", bg: "bg-canvas", level: "AA", usage: "inline link" },
  { fg: "text-link", bg: "bg-surface", level: "AA", usage: "inline link on a card" },

  { fg: "accent-text", bg: "accent-bg", level: "AA", usage: "primary button label" },
  { fg: "accent-text", bg: "accent-bg-hover", level: "AA", usage: "primary button, hovered" },
  { fg: "accent-subtle-text", bg: "accent-subtle-bg", level: "AA", usage: "info badge" },

  { fg: "success-text", bg: "success-bg", level: "AA", usage: "success button" },
  { fg: "success-subtle-text", bg: "success-subtle-bg", level: "AA", usage: "success badge" },
  { fg: "warning-text", bg: "warning-bg", level: "AA", usage: "warning button" },
  { fg: "warning-subtle-text", bg: "warning-subtle-bg", level: "AA", usage: "warning badge" },
  { fg: "danger-text", bg: "danger-bg", level: "AA", usage: "destructive button" },
  { fg: "danger-text", bg: "danger-bg-hover", level: "AA", usage: "destructive button, hovered" },
  { fg: "danger-subtle-text", bg: "danger-subtle-bg", level: "AA", usage: "error badge" },
  { fg: "info-subtle-text", bg: "info-subtle-bg", level: "AA", usage: "info callout" },

  // WCAG 1.4.11 covers boundaries *required to identify a control*, not every
  // line on the page. So `border-strong` — the edge that declares "this is an
  // input, this is a button" — is held to 3:1 and is what every interactive
  // component must use. `border-subtle` and `border-default` are structural
  // (card edges, dividers, table rules); they carry no information a user needs
  // to operate anything, and holding decorative separators to 3:1 would force a
  // harsh, high-contrast grid that doc 05 §E1 explicitly does not want.
  { fg: "border-strong", bg: "bg-surface", level: "AA-large", usage: "control boundary" },
  {
    fg: "border-strong",
    bg: "bg-canvas",
    level: "AA-large",
    usage: "control boundary on the page",
  },
  { fg: "border-strong", bg: "bg-inset", level: "AA-large", usage: "input boundary" },
  { fg: "border-focus", bg: "bg-canvas", level: "AA-large", usage: "focus ring on the page" },
  { fg: "border-focus", bg: "bg-surface", level: "AA-large", usage: "focus ring on a card" },
  { fg: "accent-bg", bg: "bg-surface", level: "AA-large", usage: "filled control against a card" },
  { fg: "danger-bg", bg: "bg-surface", level: "AA-large", usage: "destructive control on a card" },
];

/** Scale tokens. Seven type sizes, no more (doc 05 §E2). */
export const SCALE = {
  fontSize: {
    "12": "12px",
    "13": "13px",
    "14": "14px",
    "16": "16px",
    "20": "20px",
    "24": "24px",
    "32": "32px",
  },
  space: {
    "1": "4px",
    "2": "8px",
    "3": "12px",
    "4": "16px",
    "6": "24px",
    "8": "32px",
    "12": "48px",
    "16": "64px",
  },
  radius: { sm: "4px", md: "6px", lg: "8px" },
  duration: { fast: "120ms", base: "180ms" },
  rowHeight: { default: "32px", compact: "28px" },
} as const;
