import { isAllowed, PERMISSIVE, parseRobots, type RobotsRules } from "./robots.js";
import { type SafeFetchOptions, safeFetch } from "./safe-fetch.js";

/**
 * The website crawler (doc 03 §A1).
 *
 * Sitemap-first, robots-respecting, depth and domain bounded, with per-document
 * errors surfaced rather than swallowed.
 *
 * Every fetch goes through SafeFetch. Not "usually" — the crawler holds no
 * fetch of its own, because a crawler is the surface where an attacker most
 * easily supplies a URL: a page on a site you asked to crawl can link anywhere,
 * including at your own metadata endpoint.
 *
 * Sitemap-first matters for a duller reason. A docs site's sitemap is a list of
 * the pages its authors consider real, whereas link-following finds every
 * paginated archive and tag page as well. Starting from the sitemap gets a
 * better index and less of the customer's bandwidth.
 */

export type CrawlOptions = {
  readonly maxDepth?: number;
  readonly maxPages?: number;
  /** Hosts the crawl may visit. The seed's host if unset. */
  readonly allowHosts?: readonly string[];
  readonly userAgent?: string;
  readonly fetchOptions?: SafeFetchOptions;
  readonly sleep?: (ms: number) => Promise<void>;
};

export type CrawledPage = {
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: Uint8Array;
  readonly depth: number;
};

/**
 * A per-document failure.
 *
 * The doc is explicit that these are surfaced individually — "38 of 412
 * documents failed: 31 password-protected PDFs, 7 timeouts" — rather than
 * collapsed into a silent partial index, which is how stale-answer incidents
 * happen.
 */
export type CrawlError = {
  readonly url: string;
  readonly reason: string;
  readonly detail: string;
};

export type CrawlResult = {
  readonly pages: readonly CrawledPage[];
  readonly errors: readonly CrawlError[];
  readonly robots: RobotsRules;
  /** True when the crawl stopped at a bound rather than running out of links. */
  readonly truncated: boolean;
};

const DEFAULTS = { maxDepth: 3, maxPages: 200 };

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

export async function crawl(seedUrl: string, options: CrawlOptions = {}): Promise<CrawlResult> {
  const maxDepth = options.maxDepth ?? DEFAULTS.maxDepth;
  const maxPages = options.maxPages ?? DEFAULTS.maxPages;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const fetchOptions = options.fetchOptions ?? {};

  const seed = new URL(seedUrl);
  const allowHosts = new Set(options.allowHosts ?? [seed.hostname]);

  const pages: CrawledPage[] = [];
  const errors: CrawlError[] = [];
  const seen = new Set<string>();
  let truncated = false;

  // robots.txt first. A crawler that reads it and proceeds anyway is worse than
  // one that never looked: it had the information and ignored it.
  const robots = await loadRobots(seed, fetchOptions, options.userAgent ?? "keel", errors);

  const queue: { url: string; depth: number }[] = [];
  const enqueue = (url: string, depth: number) => {
    const normalised = normalise(url);
    if (normalised === null || seen.has(normalised)) return;
    const parsed = new URL(normalised);
    if (!allowHosts.has(parsed.hostname)) return;
    if (!isAllowed(robots, parsed.pathname)) return;
    seen.add(normalised);
    queue.push({ url: normalised, depth });
  };

  // The sitemap gives the authors' own list of real pages; link-following also
  // finds every tag and pagination page.
  for (const sitemapUrl of robots.sitemaps) {
    for (const url of await readSitemap(sitemapUrl, fetchOptions, errors)) enqueue(url, 0);
  }
  enqueue(seed.toString(), 0);

  while (queue.length > 0) {
    if (pages.length >= maxPages) {
      truncated = true;
      break;
    }

    const next = queue.shift();
    if (next === undefined) break;

    const result = await safeFetch(next.url, fetchOptions);
    if (!result.ok) {
      errors.push({ url: next.url, reason: result.denial.reason, detail: result.denial.detail });
      continue;
    }

    if (result.status >= 400) {
      errors.push({ url: next.url, reason: "http_error", detail: `status ${result.status}` });
      continue;
    }

    const contentType = result.headers["content-type"] ?? "text/html";
    pages.push({
      url: result.url,
      status: result.status,
      contentType,
      body: result.body,
      depth: next.depth,
    });

    if (next.depth < maxDepth && contentType.includes("html")) {
      for (const link of extractLinks(decode(result.body), result.url)) {
        enqueue(link, next.depth + 1);
      }
    }

    // Crawl-delay is obeyed when the site asked for one. Ignoring it is how a
    // crawl becomes an outage for the customer whose site is being read.
    if (robots.crawlDelayMs !== null) await sleep(robots.crawlDelayMs);
  }

  if (queue.length > 0) truncated = true;
  return { pages, errors, robots, truncated };
}

async function loadRobots(
  seed: URL,
  fetchOptions: SafeFetchOptions,
  userAgent: string,
  errors: CrawlError[],
): Promise<RobotsRules> {
  const url = new URL("/robots.txt", seed).toString();
  const result = await safeFetch(url, fetchOptions);

  if (!result.ok) {
    // A robots.txt that cannot be fetched is not permission to ignore it, but
    // it is also not a reason to abandon the crawl. Recorded, then permissive —
    // the same reading every major crawler uses for a missing file.
    errors.push({ url, reason: result.denial.reason, detail: result.denial.detail });
    return PERMISSIVE;
  }

  if (result.status === 404) return PERMISSIVE;
  return parseRobots(decode(result.body), userAgent);
}

async function readSitemap(
  url: string,
  fetchOptions: SafeFetchOptions,
  errors: CrawlError[],
): Promise<readonly string[]> {
  const result = await safeFetch(url, fetchOptions);
  if (!result.ok) {
    errors.push({ url, reason: result.denial.reason, detail: result.denial.detail });
    return [];
  }

  return extractSitemapUrls(decode(result.body));
}

/**
 * Reads `<loc>` entries from a sitemap or sitemap index.
 *
 * By regex rather than an XML parser, and for a reason that is a security
 * decision rather than laziness: a sitemap is attacker-influenced XML, and not
 * parsing it as XML means there is no XXE surface here at all.
 */
export function extractSitemapUrls(xml: string): readonly string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)]
    .map((m) => m[1] ?? "")
    .filter((url) => url.startsWith("http"));
}

/** Pulls hrefs out of HTML. Every one is re-validated by SafeFetch anyway. */
export function extractLinks(html: string, base: string): readonly string[] {
  const links: string[] = [];

  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const href = match[1] ?? "";
    if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("javascript:")) {
      continue;
    }
    try {
      links.push(new URL(href, base).toString());
    } catch {
      // A malformed href is one bad link, not a reason to stop reading a page.
    }
  }

  return links;
}

/**
 * Canonicalises a URL for the visited set.
 *
 * The fragment is dropped because `/docs#install` and `/docs` are the same
 * document, and crawling both wastes the customer's bandwidth to index the same
 * text twice. Query strings are kept: they routinely select real content.
 */
export function normalise(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return null;
  }
}
