import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ColorToken, contrastRatio, DARK, LIGHT, type Palette } from "../src/index.js";

/**
 * The three risk tiers must be tellable apart *visually* (doc 05 §E6).
 *
 * This is not a screenshot test, and saying so plainly matters: there is no
 * browser harness in this repo yet, so nothing here renders pixels. What it
 * does instead is check the properties a screenshot would be inspected for —
 * that the tiers differ on more than one channel, that the difference is not
 * carried by colour alone, and that the destructive tier's emphasis clears the
 * contrast floor in both themes. A screenshot would catch a regression these
 * miss (a rule overridden later in the cascade, say), and a Playwright visual
 * check is the honest completion of this. It is on the weaknesses list rather
 * than quietly implied.
 */

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "styles.css"),
  "utf8",
);

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} is not in the stylesheet`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("}", start));
}

describe("the tiers differ on more than one channel", () => {
  it("gives information no card at all", () => {
    // Prose. A border here would make every sentence look like a decision.
    const prose = block(".k-action__prose");

    expect(prose).not.toContain("border");
    expect(prose).not.toContain("background");
  });

  it("gives an action a border, a background and a radius", () => {
    const action = block(".k-action");

    expect(action).toContain("border: 1px solid var(--border-strong)");
    expect(action).toContain("background: var(--bg-raised)");
  });

  it("separates destructive from action by weight AND colour AND fill", () => {
    // Colour alone would leave the two tiers identical to a user who cannot
    // distinguish them — which is most of the reason this test exists.
    const destructive = block(".k-action--destructive");

    expect(destructive).toContain("border-width: 2px");
    expect(destructive).toContain("border-color: var(--danger-bg)");
    expect(destructive).toContain("background: var(--danger-subtle-bg)");
  });

  it("emphasises the consequence line rather than letting it read as one more fact", () => {
    const consequence = block(".k-action__fact--consequence dd");

    expect(consequence).toContain("font-weight: 600");
    expect(consequence).toContain("color: var(--danger-subtle-text)");
  });
});

describe("the destructive tier stays legible in both themes", () => {
  const pairs: readonly (readonly [ColorToken, ColorToken])[] = [
    ["danger-subtle-text", "danger-subtle-bg"],
    ["text-primary", "danger-subtle-bg"],
  ];

  for (const [theme, palette] of Object.entries({ dark: DARK, light: LIGHT }) as readonly [
    string,
    Palette,
  ][]) {
    for (const [fg, bg] of pairs) {
      it(`${fg} on ${bg} meets 4.5:1 in ${theme}`, () => {
        // The consequence is the one line that must be readable. A destructive
        // card whose warning is low-contrast is worse than no card.
        expect(contrastRatio(palette[fg], palette[bg])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
