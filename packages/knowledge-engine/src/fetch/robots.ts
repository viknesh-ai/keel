/**
 * robots.txt (doc 03 §A1).
 *
 * Respected, not consulted. A crawler that reads robots.txt and then decides
 * the rules do not apply to it is worse than one that never looked: it has the
 * information and ignored it, which is the difference between a bug and a
 * choice. Self-hosters crawling their own site can allow paths in config; they
 * cannot make the crawler pretend it did not see a Disallow.
 *
 * Parsing is deliberately literal about the spec's quirks — an empty `Disallow:`
 * means *allow everything*, and getting that backwards would silently skip
 * entire sites.
 */

export type RobotsRules = {
  readonly allow: readonly string[];
  readonly disallow: readonly string[];
  readonly crawlDelayMs: number | null;
  readonly sitemaps: readonly string[];
};

export const PERMISSIVE: RobotsRules = {
  allow: [],
  disallow: [],
  crawlDelayMs: null,
  sitemaps: [],
};

/**
 * Parses robots.txt for one user-agent.
 *
 * Groups for `*` and for the named agent are merged, with the named agent's
 * rules taking part in the same longest-match resolution rather than replacing
 * the wildcard group wholesale.
 */
export function parseRobots(text: string, userAgent = "keel"): RobotsRules {
  const allow: string[] = [];
  const disallow: string[] = [];
  const sitemaps: string[] = [];
  let crawlDelayMs: number | null = null;

  let applies = false;
  let sawAnyGroup = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0]?.trim() ?? "";
    if (line === "") continue;

    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "sitemap") {
      // Sitemap lines are global: they belong to the file, not to a group.
      sitemaps.push(value);
      continue;
    }

    if (field === "user-agent") {
      const agent = value.toLowerCase();
      applies = agent === "*" || agent === userAgent.toLowerCase();
      sawAnyGroup = true;
      continue;
    }

    if (!applies) continue;

    if (field === "disallow") {
      // An empty Disallow means allow everything. Treating it as "disallow /"
      // would silently skip entire sites.
      if (value !== "") disallow.push(value);
    } else if (field === "allow") {
      if (value !== "") allow.push(value);
    } else if (field === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) crawlDelayMs = seconds * 1000;
    }
  }

  return {
    allow,
    disallow,
    crawlDelayMs,
    sitemaps: sawAnyGroup || sitemaps.length > 0 ? sitemaps : [],
  };
}

/**
 * Longest-match wins, and Allow beats Disallow at equal length.
 *
 * That tie-break is what makes `Disallow: /docs` plus `Allow: /docs/public`
 * mean what its author intended. Resolving the other way would make the
 * narrower, more deliberate rule the one that loses.
 */
export function isAllowed(rules: RobotsRules, path: string): boolean {
  const match = (patterns: readonly string[]): number => {
    let best = -1;
    for (const pattern of patterns) {
      if (matchesPattern(path, pattern) && pattern.length > best) best = pattern.length;
    }
    return best;
  };

  const allowed = match(rules.allow);
  const disallowed = match(rules.disallow);

  if (disallowed === -1) return true;
  return allowed >= disallowed;
}

/** Supports the two wildcards robots.txt actually uses: `*` and a trailing `$`. */
function matchesPattern(path: string, pattern: string): boolean {
  if (!pattern.includes("*") && !pattern.endsWith("$")) return path.startsWith(pattern);

  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");

  return new RegExp(`^${escaped}${anchored ? "$" : ""}`).test(path);
}
