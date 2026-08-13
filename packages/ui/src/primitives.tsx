import { Slot } from "@radix-ui/react-slot";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { forwardRef } from "react";

/**
 * Primitives that need no Radix behaviour. Overlays live in overlays.tsx.
 *
 * House rules from doc 05 §E1 and §E4, applied throughout:
 *  - every focusable control gets `.k-focus`, which is a 2px ring at 2px offset;
 *    nothing sets outline: none
 *  - interactive boundaries use --border-strong, the only border token held to
 *    WCAG 1.4.11's 3:1 (see tokens.ts)
 *  - identifiers, ids, durations and JSON are mono, always
 *  - no gradients, one shadow, radius never above 8px
 */

const cx = (...parts: readonly (string | false | undefined)[]): string =>
  parts.filter(Boolean).join(" ");

/* ---------------------------------------------------------------- Button -- */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ControlSize = "sm" | "md";

export type ButtonProps = ComponentPropsWithoutRef<"button"> & {
  readonly variant?: ButtonVariant;
  readonly size?: ControlSize;
  readonly loading?: boolean;
  /** Render as the child element, keeping the styling. For links-as-buttons. */
  readonly asChild?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    loading = false,
    asChild = false,
    className,
    children,
    disabled,
    ...rest
  },
  ref,
) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      ref={ref}
      className={cx("k-btn", `k-btn--${variant}`, `k-btn--${size}`, "k-focus", className)}
      // A loading button is still focusable — removing it from the tab order
      // mid-interaction moves focus unpredictably for a keyboard user.
      aria-busy={loading || undefined}
      aria-disabled={disabled || loading || undefined}
      disabled={disabled ?? undefined}
      {...rest}
    >
      {loading ? <span className="k-btn__spinner" aria-hidden="true" /> : null}
      {children}
    </Comp>
  );
});

export type IconButtonProps = Omit<ButtonProps, "children"> & {
  /** Required: an icon-only control with no accessible name is unusable. */
  readonly label: string;
  readonly children: ReactNode;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, className, children, ...rest },
  ref,
) {
  return (
    <Button ref={ref} className={cx("k-iconbtn", className)} aria-label={label} {...rest}>
      {children}
    </Button>
  );
});

/* ----------------------------------------------------------------- Input -- */

export type InputProps = ComponentPropsWithoutRef<"input"> & {
  readonly invalid?: boolean;
  /** Ids, tokens and JSON read as mono. */
  readonly mono?: boolean;
  readonly size?: ControlSize;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid = false, mono = false, size = "md", className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cx("k-input", `k-input--${size}`, mono && "k-mono", "k-focus", className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});

export type TextareaProps = ComponentPropsWithoutRef<"textarea"> & {
  readonly invalid?: boolean;
  readonly mono?: boolean;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid = false, mono = false, className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cx("k-input", "k-textarea", mono && "k-mono", "k-focus", className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});

/* ----------------------------------------------------------------- Badge -- */

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

export type BadgeProps = ComponentPropsWithoutRef<"span"> & {
  readonly tone?: BadgeTone;
  readonly mono?: boolean;
};

export function Badge({ tone = "neutral", mono = false, className, ...rest }: BadgeProps) {
  return (
    <span className={cx("k-badge", `k-badge--${tone}`, mono && "k-mono", className)} {...rest} />
  );
}

/* ------------------------------------------------------------- StatusDot -- */

export type StatusKind = "running" | "success" | "warning" | "failed" | "idle";

const STATUS_LABEL: Record<StatusKind, string> = {
  running: "Running",
  success: "Succeeded",
  warning: "Warning",
  failed: "Failed",
  idle: "Idle",
};

export type StatusDotProps = {
  readonly status: StatusKind;
  /** Overrides the default label for screen readers. */
  readonly label?: string;
  readonly showLabel?: boolean;
};

export function StatusDot({ status, label, showLabel = false }: StatusDotProps) {
  const text = label ?? STATUS_LABEL[status];
  return (
    <span className="k-status">
      {/* Colour alone never carries the meaning — there is always a text label,
          visible or for assistive technology. */}
      <span className={cx("k-status__dot", `k-status__dot--${status}`)} aria-hidden="true" />
      <span className={showLabel ? "k-status__label" : "k-sr-only"}>{text}</span>
    </span>
  );
}

/* ------------------------------------------------------------ EmptyState -- */

export type EmptyStateProps = {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
};

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="k-empty">
      <p className="k-empty__title">{title}</p>
      {description === undefined ? null : <p className="k-empty__desc">{description}</p>}
      {action === undefined ? null : <div className="k-empty__action">{action}</div>}
    </div>
  );
}

/* -------------------------------------------------------------- Skeleton -- */

export type SkeletonProps = {
  readonly width?: string;
  readonly height?: string;
  readonly radius?: "sm" | "md" | "lg";
};

export function Skeleton({ width = "100%", height = "16px", radius = "sm" }: SkeletonProps) {
  return (
    <span
      className="k-skeleton"
      style={{ width, height, borderRadius: `var(--radius-${radius})` }}
      // A placeholder is decoration; announcing it interrupts a screen reader
      // with information that has no content.
      aria-hidden="true"
    />
  );
}

/* ------------------------------------------------------------- CodeBlock -- */

export type CodeBlockProps = {
  readonly code: string;
  readonly language?: string;
  readonly label?: string;
};

export function CodeBlock({ code, language, label }: CodeBlockProps) {
  return (
    <figure className="k-code">
      {label === undefined ? null : <figcaption className="k-code__label">{label}</figcaption>}
      {/* WCAG 2.1.1: a region that scrolls must be reachable by keyboard, and a
          <pre> that can overflow horizontally is exactly that. The lint rule
          objects to tabIndex on a non-interactive element in general; here the
          scroll container is the interaction.
          biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard access to a
          scrollable region is required, not optional */}
      <pre className="k-code__pre k-focus" tabIndex={0} data-language={language}>
        <code className="k-mono">{code}</code>
      </pre>
    </figure>
  );
}

/* -------------------------------------------------------------- KeyValue -- */

export type KeyValueItem = {
  readonly key: string;
  readonly value: ReactNode;
  /** Ids and tool names render mono. Prose does not. */
  readonly mono?: boolean;
};

export function KeyValue({ items }: { readonly items: readonly KeyValueItem[] }) {
  return (
    <dl className="k-kv">
      {items.map((item) => (
        <div className="k-kv__row" key={item.key}>
          <dt className="k-kv__key">{item.key}</dt>
          <dd className={cx("k-kv__value", item.mono !== false && "k-mono")}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* -------------------------------------------------------------- Duration -- */

/** Formats to three significant figures at most, so columns stay scannable. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function Duration({ ms }: { readonly ms: number }) {
  return (
    <time className="k-mono k-duration" dateTime={`PT${(ms / 1000).toFixed(3)}S`}>
      {formatDuration(ms)}
    </time>
  );
}
