import * as RDialog from "@radix-ui/react-dialog";
import * as RDropdown from "@radix-ui/react-dropdown-menu";
import * as RPopover from "@radix-ui/react-popover";
import * as RSelect from "@radix-ui/react-select";
import * as RTabs from "@radix-ui/react-tabs";
import * as RToast from "@radix-ui/react-toast";
import * as RTooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

/**
 * Floating surfaces. Radix underneath for focus management, escape handling and
 * ARIA — all of which are easy to get subtly wrong by hand and expensive to
 * discover later.
 *
 * These are the only components allowed to use --shadow-overlay: elevation is
 * reserved for things that genuinely float (doc 05 §E1).
 */

/* ---------------------------------------------------------------- Dialog -- */

export type DialogProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
  readonly footer?: ReactNode;
};

export function Dialog({ open, onOpenChange, title, description, children, footer }: DialogProps) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="k-overlay" />
        <RDialog.Content className="k-dialog" aria-describedby={description ? undefined : ""}>
          <RDialog.Title className="k-dialog__title">{title}</RDialog.Title>
          {description === undefined ? null : (
            <RDialog.Description className="k-dialog__desc">{description}</RDialog.Description>
          )}
          <div className="k-dialog__body">{children}</div>
          {footer === undefined ? null : <div className="k-dialog__footer">{footer}</div>}
          <RDialog.Close className="k-dialog__close k-focus" aria-label="Close">
            ×
          </RDialog.Close>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/* --------------------------------------------------------------- Popover -- */

export type PopoverProps = {
  readonly trigger: ReactNode;
  readonly children: ReactNode;
  readonly align?: "start" | "center" | "end";
};

export function Popover({ trigger, children, align = "start" }: PopoverProps) {
  return (
    <RPopover.Root>
      <RPopover.Trigger asChild>{trigger}</RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content className="k-popover" align={align} sideOffset={6}>
          {children}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}

/* ---------------------------------------------------------- DropdownMenu -- */

export type MenuItem = {
  readonly id: string;
  readonly label: string;
  readonly onSelect: () => void;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
};

export type DropdownMenuProps = {
  readonly trigger: ReactNode;
  readonly items: readonly MenuItem[];
  readonly align?: "start" | "center" | "end";
};

export function DropdownMenu({ trigger, items, align = "end" }: DropdownMenuProps) {
  return (
    <RDropdown.Root>
      <RDropdown.Trigger asChild>{trigger}</RDropdown.Trigger>
      <RDropdown.Portal>
        <RDropdown.Content className="k-menu" align={align} sideOffset={6}>
          {items.map((item) => (
            <RDropdown.Item
              key={item.id}
              className={
                item.destructive === true ? "k-menu__item k-menu__item--danger" : "k-menu__item"
              }
              disabled={item.disabled ?? false}
              onSelect={item.onSelect}
            >
              {item.label}
            </RDropdown.Item>
          ))}
        </RDropdown.Content>
      </RDropdown.Portal>
    </RDropdown.Root>
  );
}

/* --------------------------------------------------------------- Tooltip -- */

/** Wraps the app once. Radix requires a provider for delay coordination. */
export function TooltipProvider({ children }: { readonly children: ReactNode }) {
  return <RTooltip.Provider delayDuration={300}>{children}</RTooltip.Provider>;
}

export type TooltipProps = {
  readonly content: string;
  readonly children: ReactNode;
};

export function Tooltip({ content, children }: TooltipProps) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content className="k-tooltip" sideOffset={6}>
          {content}
          <RTooltip.Arrow className="k-tooltip__arrow" />
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

/* ------------------------------------------------------------------ Tabs -- */

export type TabItem = {
  readonly id: string;
  readonly label: string;
  readonly content: ReactNode;
};

export type TabsProps = {
  readonly items: readonly TabItem[];
  readonly defaultId?: string;
  readonly label: string;
};

export function Tabs({ items, defaultId, label }: TabsProps) {
  const first = items[0]?.id;
  if (first === undefined) return null;

  return (
    <RTabs.Root defaultValue={defaultId ?? first} className="k-tabs">
      <RTabs.List className="k-tabs__list" aria-label={label}>
        {items.map((item) => (
          <RTabs.Trigger key={item.id} value={item.id} className="k-tabs__trigger k-focus">
            {item.label}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {items.map((item) => (
        <RTabs.Content key={item.id} value={item.id} className="k-tabs__content k-focus">
          {item.content}
        </RTabs.Content>
      ))}
    </RTabs.Root>
  );
}

/* ---------------------------------------------------------------- Select -- */

export type SelectOption = {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
};

export type SelectProps = {
  readonly value?: string;
  readonly onValueChange: (value: string) => void;
  readonly options: readonly SelectOption[];
  readonly placeholder?: string;
  readonly label: string;
};

export function Select({ value, onValueChange, options, placeholder, label }: SelectProps) {
  return (
    <RSelect.Root {...(value === undefined ? {} : { value })} onValueChange={onValueChange}>
      <RSelect.Trigger className="k-select k-focus" aria-label={label}>
        <RSelect.Value placeholder={placeholder ?? "Select…"} />
        <RSelect.Icon className="k-select__icon">▾</RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content className="k-menu" position="popper" sideOffset={6}>
          <RSelect.Viewport>
            {options.map((option) => (
              <RSelect.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled ?? false}
                className="k-menu__item"
              >
                <RSelect.ItemText>{option.label}</RSelect.ItemText>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}

/* ----------------------------------------------------------------- Toast -- */

export type ToastTone = "neutral" | "success" | "danger";

export type ToastMessage = {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly tone?: ToastTone;
};

type ToastApi = { readonly push: (message: Omit<ToastMessage, "id">) => void };

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) throw new Error("useToast must be used inside <ToastProvider>");
  return api;
}

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [messages, setMessages] = useState<readonly ToastMessage[]>([]);

  const push = useCallback((message: Omit<ToastMessage, "id">) => {
    setMessages((current) => [...current, { ...message, id: crypto.randomUUID() }]);
  }, []);

  const api = useMemo<ToastApi>(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      <RToast.Provider swipeDirection="right">
        {children}
        {messages.map((message) => (
          <RToast.Root
            key={message.id}
            className={`k-toast k-toast--${message.tone ?? "neutral"}`}
            onOpenChange={(open) => {
              if (!open) setMessages((current) => current.filter((m) => m.id !== message.id));
            }}
          >
            <RToast.Title className="k-toast__title">{message.title}</RToast.Title>
            {message.description === undefined ? null : (
              <RToast.Description className="k-toast__desc">
                {message.description}
              </RToast.Description>
            )}
            <RToast.Close className="k-toast__close k-focus" aria-label="Dismiss">
              ×
            </RToast.Close>
          </RToast.Root>
        ))}
        <RToast.Viewport className="k-toast__viewport" />
      </RToast.Provider>
    </ToastContext.Provider>
  );
}
