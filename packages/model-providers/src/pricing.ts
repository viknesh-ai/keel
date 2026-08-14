/**
 * Cost per million tokens, in USD.
 *
 * A table, not an API call: cost has to be computable synchronously while a
 * stream is closing, and a run's recorded cost must not change because a price
 * page did. Prices are checked in and dated, so a stale one is visible in a
 * diff rather than silently wrong.
 *
 * A model that is not listed costs 0 and is reported as unpriced rather than
 * guessed. A guessed cost that feeds a budget is worse than an absent one.
 */

export type Price = {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok?: number;
};

/** Last reviewed 2026-08-13. */
export const PRICES: Readonly<Record<string, Price>> = {
  "claude-opus-4-1": { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5 },
  "claude-sonnet-4-5": { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1 },
};

export function priceFor(model: string): Price | undefined {
  return PRICES[model];
}

/** Locally hosted models cost nothing per token, and that is not a missing price. */
export function isLocal(baseUrl: string): boolean {
  return /localhost|127\.0\.0\.1|::1|host\.docker\.internal/.test(baseUrl);
}

export function estimateCostUsd(
  model: string,
  usage: { tokens_in: number; tokens_out: number; cache_read_tokens: number },
  options: { local?: boolean } = {},
): number {
  if (options.local === true) return 0;

  const price = priceFor(model);
  if (price === undefined) return 0;

  const billableIn = Math.max(0, usage.tokens_in - usage.cache_read_tokens);
  const cached = usage.cache_read_tokens * (price.cacheReadPerMTok ?? price.inputPerMTok);

  return (
    (billableIn * price.inputPerMTok + usage.tokens_out * price.outputPerMTok + cached) / 1_000_000
  );
}

/** True when the cost figure is a real price rather than a zero standing in for one. */
export function isPriced(model: string, options: { local?: boolean } = {}): boolean {
  return options.local === true || priceFor(model) !== undefined;
}
