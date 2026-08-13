import { describe, expect, it } from "vitest";
import { contrastRatio, MINIMUM_RATIO, meetsContrast, parseHex } from "../src/contrast.js";
import { CONTRAST_PAIRS, DARK, LIGHT, THEMES, type ThemeName } from "../src/tokens.js";

/**
 * The CI gate doc 05 §E2 asks for: "the CI runs a contrast check over the token
 * matrix so a theme tweak can't silently break it."
 */

describe("contrastRatio — known values from the WCAG spec", () => {
  it("is 21 for black on white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });

  it("is 1 for a colour against itself", () => {
    expect(contrastRatio("#2f6fed", "#2f6fed")).toBeCloseTo(1, 10);
  });

  it("is order-independent", () => {
    expect(contrastRatio("#11151b", "#f7f8fa")).toBeCloseTo(
      contrastRatio("#f7f8fa", "#11151b"),
      10,
    );
  });

  it("accepts shorthand hex", () => {
    expect(parseHex("#fff")).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("rejects anything that is not a hex colour", () => {
    for (const bad of ["", "#12", "rgb(0,0,0)", "#gggggg", "blue"]) {
      expect(() => parseHex(bad)).toThrow();
    }
  });
});

describe.each(["dark", "light"] as const)("%s theme meets WCAG AA", (theme: ThemeName) => {
  const palette = THEMES[theme];

  it.each(CONTRAST_PAIRS.map((p) => [`${p.fg} on ${p.bg} (${p.usage})`, p] as const))(
    "%s",
    (_label, pair) => {
      const fg = palette[pair.fg];
      const bg = palette[pair.bg];
      const ratio = contrastRatio(fg, bg);

      expect(
        meetsContrast(fg, bg, pair.level),
        `${theme}: ${pair.fg} (${fg}) on ${pair.bg} (${bg}) is ${ratio.toFixed(2)}:1, below the ${
          MINIMUM_RATIO[pair.level]
        }:1 required for ${pair.level} — ${pair.usage}`,
      ).toBe(true);
    },
  );
});

describe("the token matrix is complete", () => {
  it("defines every token in both themes", () => {
    expect(Object.keys(DARK).sort()).toEqual(Object.keys(LIGHT).sort());
  });

  it("uses hex values throughout, so the checker can read them", () => {
    for (const [theme, palette] of Object.entries(THEMES)) {
      for (const [token, value] of Object.entries(palette)) {
        expect(() => parseHex(value), `${theme}.${token} = ${value}`).not.toThrow();
      }
    }
  });

  it("checks every pair against a token that actually exists", () => {
    for (const pair of CONTRAST_PAIRS) {
      expect(DARK[pair.fg], `unknown fg token ${pair.fg}`).toBeDefined();
      expect(DARK[pair.bg], `unknown bg token ${pair.bg}`).toBeDefined();
    }
  });
});

describe("the gate would actually fire", () => {
  it("fails a pairing that is genuinely too low", () => {
    // Mid grey on mid grey — about 1.3:1. If this passed, the suite would be
    // decorative.
    expect(meetsContrast("#888888", "#7a7a7a", "AA")).toBe(false);
  });

  it("distinguishes the AA and AA-large thresholds", () => {
    // ~3.1:1 — enough for a border, not enough for body text.
    const fg = "#767676";
    const bg = "#ffffff";
    const ratio = contrastRatio(fg, bg);
    expect(ratio).toBeGreaterThan(3);
    expect(ratio).toBeLessThan(4.6);
    expect(meetsContrast(fg, bg, "AA-large")).toBe(true);
  });
});
