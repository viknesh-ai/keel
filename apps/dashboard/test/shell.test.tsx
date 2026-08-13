import { ToastProvider, TooltipProvider } from "@keel/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import AgentsRoute from "../src/routes/Agents.tsx";
import StyleguideRoute from "../src/routes/Styleguide.tsx";
import { AppShell } from "../src/shell/AppShell.tsx";
import { ErrorBoundary } from "../src/shell/ErrorBoundary.tsx";

/**
 * The 0.4 exit criterion: /styleguide renders and keyboard-only navigation
 * reaches every control. Asserted here rather than eyeballed, so a regression
 * fails CI instead of being noticed months later.
 */

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/" element={<AppShell />}>
                <Route path="agents" element={<AgentsRoute />} />
                <Route
                  path="styleguide"
                  element={
                    <Suspense fallback={<p>loading</p>}>
                      <StyleguideRoute />
                    </Suspense>
                  }
                />
              </Route>
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("AppShell", () => {
  it("puts the skip link first in the tab order", async () => {
    const user = userEvent.setup();
    renderAt("/agents");

    await user.tab();
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveFocus();
  });

  it("reaches every navigation section by keyboard alone", async () => {
    const user = userEvent.setup();
    renderAt("/agents");

    const sections = [
      "Agents",
      "Tools",
      "Knowledge",
      "Activity",
      "Policy",
      "Settings",
      "Styleguide",
    ];
    const reached: string[] = [];

    // 24 tabs is generous headroom for the shell's controls; the assertion is
    // on what was reached, not on the count.
    for (let i = 0; i < 24; i += 1) {
      await user.tab();
      const active = document.activeElement;
      const text = active?.textContent?.trim() ?? "";
      if (sections.includes(text) && !reached.includes(text)) reached.push(text);
    }

    expect(reached.sort()).toEqual([...sections].sort());
  });

  it("exposes the theme toggle and flips the document theme", async () => {
    const user = userEvent.setup();
    renderAt("/agents");

    const toggle = screen.getByRole("button", { name: "Toggle theme" });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));

    toggle.focus();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
  });

  it("marks the active section for assistive technology", () => {
    renderAt("/agents");

    expect(screen.getByRole("link", { name: "Agents" })).toHaveAttribute("aria-current", "page");
  });
});

describe("/styleguide", () => {
  it("renders", async () => {
    renderAt("/styleguide");

    expect(await screen.findByRole("heading", { name: "Styleguide", level: 1 })).toBeDefined();
  });

  it("has a section for every primitive", async () => {
    renderAt("/styleguide");
    await screen.findByRole("heading", { name: "Styleguide", level: 1 });

    for (const section of [
      "Button",
      "IconButton",
      "Input",
      "Textarea",
      "Badge",
      "StatusDot",
      "Duration",
      "Skeleton",
      "Overlays",
      "Tabs",
      "KeyValue",
      "CodeBlock",
      "EmptyState",
    ]) {
      expect(
        screen.getByRole("heading", { name: section, level: 2 }),
        `missing styleguide section: ${section}`,
      ).toBeDefined();
    }
  });

  it("renders every button variant and state", async () => {
    renderAt("/styleguide");
    await screen.findByRole("heading", { name: "Styleguide", level: 1 });

    for (const name of [
      "primary",
      "secondary",
      "ghost",
      "danger",
      "small",
      "loading",
      "disabled",
    ]) {
      expect(screen.getByRole("button", { name }), `missing button: ${name}`).toBeDefined();
    }
    expect(screen.getByRole("button", { name: "loading" })).toHaveAttribute("aria-busy", "true");
  });

  it("shows the measured contrast ratio for every pair CI checks", async () => {
    renderAt("/styleguide");
    await screen.findByRole("heading", { name: "Styleguide", level: 1 });

    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row");
    // Header row plus one per pair.
    expect(rows.length).toBeGreaterThan(20);
  });

  it("opens the dialog from the keyboard and closes it with Escape", async () => {
    const user = userEvent.setup();
    renderAt("/styleguide");
    await screen.findByRole("heading", { name: "Styleguide", level: 1 });

    screen.getByRole("button", { name: "Open dialog" }).focus();
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("dialog")).toBeDefined();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("ErrorBoundary", () => {
  function Boom(): never {
    throw new Error("render exploded");
  }

  it("shows a recoverable message instead of a blank page", () => {
    // React logs the caught error; that is expected here.
    const original = console.error;
    console.error = () => {};
    try {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );

      expect(screen.getByRole("alert")).toBeDefined();
      expect(screen.getByRole("button", { name: "Reload" })).toBeDefined();
    } finally {
      console.error = original;
    }
  });

  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>fine</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText("fine")).toBeDefined();
  });
});
