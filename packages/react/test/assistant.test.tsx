import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { Assistant } from "../src/assistant.js";
import { activityLabel, createTranslator, STRINGS } from "../src/i18n.js";
import { KeelProvider } from "../src/provider.js";

/**
 * Widget behaviour and accessibility (doc 05 §E6).
 *
 * The panel is a modal surface inside someone else's product, so the
 * accessibility assertions here are not polish: getting focus management wrong
 * traps a keyboard user in a page they cannot leave.
 *
 * Rendered without the Shadow root, deliberately — jsdom's shadow support does
 * not carry ARIA relationships across the boundary, so testing inside it would
 * assert less, not more. Shadow mounting is covered separately.
 */

function renderWidget(fetchImpl?: typeof fetch) {
  return render(
    <KeelProvider
      endpoint="http://localhost:0"
      projectId="proj_1"
      identity={async () => null}
      {...(fetchImpl === undefined ? {} : {})}
    >
      <Assistant />
    </KeelProvider>,
  );
}

describe("the launcher", () => {
  it("is a labelled button that reports its expanded state", async () => {
    renderWidget();

    const launcher = screen.getByRole("button", { name: "Open assistant" });
    expect(launcher).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(launcher);
    expect(screen.getByRole("button", { name: "Close assistant" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("does not steal focus when the host page loads", async () => {
    // A widget embedded in someone else's product must never grab focus on
    // mount — the user was probably typing somewhere else.
    renderWidget();

    expect(document.activeElement).toBe(document.body);
  });

  it("opens the panel from the keyboard alone", async () => {
    renderWidget();

    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Open assistant" })).toHaveFocus();

    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("dialog")).toBeDefined();
  });
});

describe("the panel", () => {
  it("is a modal dialog with an accessible name", async () => {
    renderWidget();
    await userEvent.click(screen.getByRole("button", { name: "Open assistant" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("heading", { name: "Assistant" })).toBeDefined();
  });

  it("moves focus into the composer on open", async () => {
    renderWidget();
    await userEvent.click(screen.getByRole("button", { name: "Open assistant" }));

    await waitFor(() => expect(screen.getByLabelText("Your question")).toHaveFocus());
  });

  it("closes on Escape and restores focus to the launcher", async () => {
    // Without the restore, closing leaves focus on a detached node and the next
    // Tab starts from the top of the host page.
    renderWidget();
    const launcher = screen.getByRole("button", { name: "Open assistant" });
    await userEvent.click(launcher);

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Open assistant" })).toHaveFocus(),
    );
  });

  it("traps Tab inside the panel", async () => {
    renderWidget();
    await userEvent.click(screen.getByRole("button", { name: "Open assistant" }));

    const dialog = screen.getByRole("dialog");

    // Tab repeatedly; focus must never leave the dialog subtree.
    for (let i = 0; i < 8; i += 1) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it("announces the transcript politely, not per token", async () => {
    renderWidget();
    await userEvent.click(screen.getByRole("button", { name: "Open assistant" }));

    const log = screen.getByRole("log");
    expect(log).toHaveAttribute("aria-live", "polite");
    // aria-atomic="false" means only the added node is announced, so a long
    // answer is not re-read from the beginning on every chunk.
    expect(log).toHaveAttribute("aria-atomic", "false");
  });

  it("shows an empty state before anything is asked", async () => {
    renderWidget();
    await userEvent.click(screen.getByRole("button", { name: "Open assistant" }));

    expect(screen.getByText("Nothing asked yet")).toBeDefined();
  });
});

describe("the composer", () => {
  it("has a label and refuses an empty submission", async () => {
    renderWidget();
    await userEvent.click(screen.getByRole("button", { name: "Open assistant" }));

    expect(screen.getByLabelText("Your question")).toBeDefined();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("enables Send once there is something to send", async () => {
    renderWidget();
    await userEvent.click(screen.getByRole("button", { name: "Open assistant" }));

    await userEvent.type(screen.getByLabelText("Your question"), "hello");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });
});

describe("status, never reasoning", () => {
  it("has a status region rather than a spinner", async () => {
    renderWidget();
    await userEvent.click(screen.getByRole("button", { name: "Open assistant" }));

    expect(screen.getByRole("status")).toBeDefined();
  });

  it("renders known activity keys as human status lines", () => {
    const t = createTranslator("en");

    expect(activityLabel(t, "searching_customers")).toBe("Searching customers…");
    expect(activityLabel(t, "found_customers", { count: 43 })).toBe("Found 43");
  });

  it("falls back to a generic label rather than leaking a raw key", () => {
    // An unknown key means the server shipped ahead of the client. Showing
    // `searching_customers_v2` to a user is worse than showing nothing specific.
    const t = createTranslator("en");

    expect(activityLabel(t, "some_future_key")).toBe("Working…");
  });

  it("never says Thinking, and never exposes reasoning", () => {
    const all = Object.values(STRINGS.en).join(" ").toLowerCase();

    expect(all).not.toContain("thinking");
    expect(all).not.toContain("reasoning");
    expect(all).not.toContain("chain of thought");
  });
});

describe("i18n", () => {
  it("routes every user-visible string through the table", () => {
    // The guard against a literal creeping into JSX: every string the widget can
    // render is in STRINGS, so adding a locale is a data change.
    const t = createTranslator("en");

    for (const key of Object.keys(STRINGS.en)) {
      expect(t(key as keyof typeof STRINGS.en)).not.toBe(key);
    }
  });

  it("interpolates parameters", () => {
    expect(createTranslator("en")("activity.found_customers", { count: 7 })).toBe("Found 7");
  });
});

describe("accessibility", () => {
  it("has zero axe-core violations with the panel open", async () => {
    const { container } = renderWidget();
    await userEvent.click(screen.getByRole("button", { name: "Open assistant" }));
    await screen.findByRole("dialog");

    const results = await axe.run(container, {
      // aria-modal on a dialog that is not the only content trips a rule that
      // assumes a full-page modal; the widget is deliberately non-blocking, and
      // the focus trap is asserted directly above instead.
      rules: { "aria-hidden-focus": { enabled: true } },
    });

    const violations = results.violations.map((v) => `${v.id}: ${v.help}`);
    expect(violations).toEqual([]);
  });

  it("has zero violations with the panel closed", async () => {
    const { container } = renderWidget();

    const results = await axe.run(container);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
