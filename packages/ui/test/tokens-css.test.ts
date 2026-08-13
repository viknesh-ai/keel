import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { emitTokensCss } from "../src/emit-css.js";
import { DARK, LIGHT } from "../src/tokens.js";

const cssPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "tokens.css");

describe("tokens.css is generated, not maintained", () => {
  it("matches what the emitter produces — a stale file fails here rather than shipping unverified colours", () => {
    expect(readFileSync(cssPath, "utf8")).toBe(emitTokensCss());
  });

  it("declares every token in both theme blocks", () => {
    const css = readFileSync(cssPath, "utf8");
    for (const token of Object.keys(DARK)) {
      expect(css, `--${token} missing`).toContain(`--${token}:`);
    }
    expect(Object.keys(LIGHT)).toEqual(Object.keys(DARK));
  });

  it("ships dark as the default, with light behind an explicit attribute", () => {
    const css = readFileSync(cssPath, "utf8");
    expect(css).toContain(':root,\n[data-theme="dark"]');
    expect(css).toContain('[data-theme="light"]');
  });

  it("honours prefers-reduced-motion", () => {
    expect(readFileSync(cssPath, "utf8")).toContain("prefers-reduced-motion: reduce");
  });
});
