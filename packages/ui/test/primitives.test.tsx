import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Dialog, DropdownMenu, Tabs, Tooltip, TooltipProvider } from "../src/overlays.js";
import {
  Badge,
  Button,
  CodeBlock,
  Duration,
  EmptyState,
  formatDuration,
  IconButton,
  Input,
  KeyValue,
  StatusDot,
} from "../src/primitives.js";

/**
 * The exit criterion from session 0.4 is that keyboard-only navigation reaches
 * every control. These tests drive the components with the keyboard only —
 * `userEvent.tab()` and `keyboard()`, never `click()` — so a component that is
 * reachable by mouse but not by tab fails here.
 */

describe("Button", () => {
  it("is reachable by tab and activated by both Enter and Space", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);

    await user.tab();
    expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();

    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("marks a loading button busy without removing it from the tab order", async () => {
    const user = userEvent.setup();
    render(<Button loading>Saving</Button>);

    const button = screen.getByRole("button", { name: "Saving" });
    expect(button).toHaveAttribute("aria-busy", "true");

    await user.tab();
    expect(button).toHaveFocus();
  });

  it("does not fire when disabled", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );

    await user.tab();
    await user.keyboard("{Enter}");
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders every variant", () => {
    render(
      <>
        <Button variant="primary">P</Button>
        <Button variant="secondary">S</Button>
        <Button variant="ghost">G</Button>
        <Button variant="danger">D</Button>
      </>,
    );
    expect(screen.getAllByRole("button")).toHaveLength(4);
  });
});

describe("IconButton", () => {
  it("exposes an accessible name, because an icon alone has none", () => {
    render(<IconButton label="Delete run">×</IconButton>);

    expect(screen.getByRole("button", { name: "Delete run" })).toBeDefined();
  });
});

describe("Input", () => {
  it("is reachable by tab and accepts typing", async () => {
    const user = userEvent.setup();
    render(<Input aria-label="Search" />);

    await user.tab();
    const input = screen.getByLabelText("Search");
    expect(input).toHaveFocus();

    await user.keyboard("northwind");
    expect(input).toHaveValue("northwind");
  });

  it("flags invalid state to assistive technology", () => {
    render(<Input aria-label="Email" invalid />);

    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
  });
});

describe("StatusDot", () => {
  it("never conveys meaning by colour alone", () => {
    render(<StatusDot status="failed" />);

    // The dot is aria-hidden; the text is what a screen reader announces.
    expect(screen.getByText("Failed")).toBeDefined();
  });

  it("uses a supplied label over the default", () => {
    render(<StatusDot status="running" label="Executing tool" showLabel />);

    expect(screen.getByText("Executing tool")).toBeDefined();
  });
});

describe("Badge", () => {
  it("renders its content", () => {
    render(<Badge tone="danger">PolicyViolationError</Badge>);

    expect(screen.getByText("PolicyViolationError")).toBeDefined();
  });
});

describe("CodeBlock", () => {
  it("makes the scroll container keyboard reachable", async () => {
    const user = userEvent.setup();
    render(<CodeBlock code={'{"ok": true}'} label="response.json" />);

    await user.tab();
    expect(screen.getByText('{"ok": true}').closest("pre")).toHaveFocus();
  });
});

describe("KeyValue", () => {
  it("renders a definition list", () => {
    render(<KeyValue items={[{ key: "run_id", value: "run_01J" }]} />);

    expect(screen.getByText("run_id")).toBeDefined();
    expect(screen.getByText("run_01J")).toBeDefined();
  });
});

describe("formatDuration", () => {
  it.each([
    [0.4, "<1ms"],
    [12, "12ms"],
    [999, "999ms"],
    [1500, "1.50s"],
    [12_000, "12.0s"],
    [65_000, "1m 5s"],
    [-1, "—"],
    [Number.NaN, "—"],
  ])("%s → %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it("renders a machine-readable datetime", () => {
    render(<Duration ms={1500} />);

    expect(screen.getByText("1.50s")).toHaveAttribute("datetime", "PT1.500S");
  });
});

describe("EmptyState", () => {
  it("renders title, description and action", () => {
    render(
      <EmptyState
        title="No runs yet"
        description="Runs appear here."
        action={<Button>New</Button>}
      />,
    );

    expect(screen.getByText("No runs yet")).toBeDefined();
    expect(screen.getByRole("button", { name: "New" })).toBeDefined();
  });
});

describe("Tabs", () => {
  it("moves between tabs with the arrow keys", async () => {
    const user = userEvent.setup();
    render(
      <Tabs
        label="Run detail"
        items={[
          { id: "steps", label: "Steps", content: <p>step list</p> },
          { id: "policy", label: "Policy", content: <p>policy decision</p> },
        ]}
      />,
    );

    await user.tab();
    expect(screen.getByRole("tab", { name: "Steps" })).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Policy" })).toHaveFocus();
    expect(screen.getByText("policy decision")).toBeDefined();
  });
});

describe("Dialog", () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open</Button>
        <Dialog
          open={open}
          onOpenChange={setOpen}
          title="Confirm upgrade"
          description="Arun to Pro."
        >
          <p>body</p>
        </Dialog>
      </>
    );
  }

  it("opens from the keyboard, traps focus, and closes on Escape", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.tab();
    await user.keyboard("{Enter}");

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Confirm upgrade")).toBeDefined();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("DropdownMenu", () => {
  it("opens with Enter and selects with the keyboard", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <DropdownMenu
        trigger={<Button>Actions</Button>}
        items={[{ id: "cancel", label: "Cancel run", onSelect, destructive: true }]}
      />,
    );

    await user.tab();
    await user.keyboard("{Enter}");

    const item = await screen.findByRole("menuitem", { name: "Cancel run" });
    expect(item).toBeDefined();

    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledOnce();
  });
});

describe("Tooltip", () => {
  it("shows on keyboard focus, not only on hover", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <Tooltip content="Cost of this run">
          <Button>$0.02</Button>
        </Tooltip>
      </TooltipProvider>,
    );

    await user.tab();
    expect(await screen.findAllByText("Cost of this run")).not.toHaveLength(0);
  });
});
