/**
 * WCAG 2.1 relative luminance and contrast ratio.
 *
 * Implemented here rather than pulled in as a dependency because it is twenty
 * lines of arithmetic straight out of the spec, and because the CI gate that
 * depends on it should not be able to drift with someone else's release.
 */

export type Rgb = { readonly r: number; readonly g: number; readonly b: number };

export function parseHex(hex: string): Rgb {
  const value = hex.trim().replace(/^#/, "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;

  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`not a hex colour: ${hex}`);
  }

  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

/** WCAG 2.1 §relative luminance. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Ratio between 1 and 21, order-independent. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(parseHex(a));
  const lb = relativeLuminance(parseHex(b));
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

export const MINIMUM_RATIO = { AA: 4.5, "AA-large": 3 } as const;

export function meetsContrast(
  foreground: string,
  background: string,
  level: keyof typeof MINIMUM_RATIO,
): boolean {
  // Rounded to 2dp first: a ratio of 4.4996 displays as 4.5 in every checker a
  // designer will use, and failing it would be indistinguishable from a bug.
  return Math.round(contrastRatio(foreground, background) * 100) / 100 >= MINIMUM_RATIO[level];
}
