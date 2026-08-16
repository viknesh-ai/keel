import { describe, expect, it } from "vitest";
import { crawl, extractLinks, extractSitemapUrls, normalise } from "../src/fetch/crawler.js";
import { isAllowed, parseRobots } from "../src/fetch/robots.js";
import type { Resolver } from "../src/fetch/safe-fetch.js";

/**
 * The website crawler (doc 03 §A1) and robots.txt handling.
 *
 * The crawler is the surface where an attacker most easily supplies a URL — a
 * page on a site you asked to crawl can link anywhere, including at your own
 * metadata endpoint — so the test that matters most is the one proving a
 * crawled link cannot reach a private address.
 */

/** Everything resolves to one public address unless a test says otherwise. */
const resolver: Resolver = async () => [{ address: "93.184.216.34", family: 4 }];

/** A tiny site, served from a map of path → [contentType, body]. */
function site(pages: Record<string, [string, string]>) {
  const requested: string[] = [];

  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const host = (init.headers as Record<string, string>).host ?? "";
    requested.push(path);

    const page = pages[path];
    if (page === undefined) return new Response("not found", { status: 404 });
    return new Response(page[1], {
      status: 200,
      headers: { "content-type": page[0], "x-host": host },
    });
  }) as unknown as typeof globalThis.fetch;

  return { fetchImpl, requested };
}

const html = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

describe("robots.txt is respected", () => {
  it("reads an empty Disallow as allow-everything", () => {
    // Getting this backwards silently skips entire sites, and it is the single
    // most common robots.txt parsing bug.
    const rules = parseRobots("User-agent: *\nDisallow:");

    expect(rules.disallow).toEqual([]);
    expect(isAllowed(rules, "/anything")).toBe(true);
  });

  it("disallows a path under a Disallow rule", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /private");

    expect(isAllowed(rules, "/private/secrets")).toBe(false);
    expect(isAllowed(rules, "/public")).toBe(true);
  });

  it("lets a longer Allow beat a shorter Disallow", () => {
    // Otherwise the narrower, more deliberate rule is the one that loses.
    const rules = parseRobots("User-agent: *\nDisallow: /docs\nAllow: /docs/public");

    expect(isAllowed(rules, "/docs/internal")).toBe(false);
    expect(isAllowed(rules, "/docs/public/guide")).toBe(true);
  });

  it("honours wildcards and end-anchors", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /*.pdf$");

    expect(isAllowed(rules, "/files/report.pdf")).toBe(false);
    expect(isAllowed(rules, "/files/report.pdf.html")).toBe(true);
  });

  it("applies rules for our own agent as well as the wildcard group", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /a\n\nUser-agent: keel\nDisallow: /b");

    expect(isAllowed(rules, "/a")).toBe(false);
    expect(isAllowed(rules, "/b")).toBe(false);
  });

  it("ignores a group written for a different crawler", () => {
    const rules = parseRobots("User-agent: gptbot\nDisallow: /");

    expect(isAllowed(rules, "/docs")).toBe(true);
  });

  it("collects sitemaps, which are file-global rather than per-group", () => {
    const rules = parseRobots("Sitemap: https://x.example/sitemap.xml\nUser-agent: *\nDisallow:");

    expect(rules.sitemaps).toEqual(["https://x.example/sitemap.xml"]);
  });

  it("reads crawl-delay", () => {
    expect(parseRobots("User-agent: *\nCrawl-delay: 2").crawlDelayMs).toBe(2000);
  });

  it("ignores comments", () => {
    const rules = parseRobots("# a comment\nUser-agent: *\nDisallow: /x # trailing");

    expect(rules.disallow).toEqual(["/x"]);
  });
});

describe("the crawl is bounded", () => {
  it("starts from the sitemap rather than only from links", async () => {
    // A docs site's sitemap is the authors' own list of real pages; following
    // links also finds every tag and pagination page.
    const { fetchImpl, requested } = site({
      "/robots.txt": [
        "text/plain",
        "Sitemap: https://docs.example/sitemap.xml\nUser-agent: *\nDisallow:",
      ],
      "/sitemap.xml": [
        "application/xml",
        "<urlset><url><loc>https://docs.example/a</loc></url><url><loc>https://docs.example/b</loc></url></urlset>",
      ],
      "/": ["text/html", html("<p>home</p>")],
      "/a": ["text/html", html("<p>a</p>")],
      "/b": ["text/html", html("<p>b</p>")],
    });

    const result = await crawl("https://docs.example/", {
      fetchOptions: { resolver, fetchImpl },
    });

    expect(result.pages.map((p) => new URL(p.url).pathname).sort()).toEqual(["/", "/a", "/b"]);
    expect(requested).toContain("/sitemap.xml");
  });

  it("does not leave the allowed hosts", async () => {
    const { fetchImpl, requested } = site({
      "/robots.txt": ["text/plain", "User-agent: *\nDisallow:"],
      "/": [
        "text/html",
        html('<a href="https://elsewhere.example/leak">out</a><a href="/in">in</a>'),
      ],
      "/in": ["text/html", html("<p>in</p>")],
    });

    const result = await crawl("https://docs.example/", { fetchOptions: { resolver, fetchImpl } });

    expect(result.pages.map((p) => new URL(p.url).hostname)).toEqual([
      "docs.example",
      "docs.example",
    ]);
    expect(requested).not.toContain("/leak");
  });

  it("stops at the depth bound", async () => {
    const { fetchImpl } = site({
      "/robots.txt": ["text/plain", "User-agent: *\nDisallow:"],
      "/": ["text/html", html('<a href="/one">1</a>')],
      "/one": ["text/html", html('<a href="/two">2</a>')],
      "/two": ["text/html", html('<a href="/three">3</a>')],
      "/three": ["text/html", html("<p>3</p>")],
    });

    const result = await crawl("https://docs.example/", {
      maxDepth: 1,
      fetchOptions: { resolver, fetchImpl },
    });

    expect(result.pages.map((p) => new URL(p.url).pathname)).toEqual(["/", "/one"]);
  });

  it("stops at the page bound and says it was truncated", async () => {
    // Silently stopping would produce a partial index that reports as complete,
    // which is how stale-answer incidents happen.
    const pages: Record<string, [string, string]> = {
      "/robots.txt": ["text/plain", "User-agent: *\nDisallow:"],
      "/": [
        "text/html",
        html(Array.from({ length: 10 }, (_v, i) => `<a href="/p${i}">${i}</a>`).join("")),
      ],
    };
    for (let i = 0; i < 10; i += 1) pages[`/p${i}`] = ["text/html", html(`<p>${i}</p>`)];

    const result = await crawl("https://docs.example/", {
      maxPages: 3,
      fetchOptions: { resolver, fetchImpl: site(pages).fetchImpl },
    });

    expect(result.pages).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("skips paths robots.txt disallows", async () => {
    const { fetchImpl, requested } = site({
      "/robots.txt": ["text/plain", "User-agent: *\nDisallow: /private"],
      "/": ["text/html", html('<a href="/private/x">no</a><a href="/public">yes</a>')],
      "/public": ["text/html", html("<p>ok</p>")],
      "/private/x": ["text/html", html("<p>secret</p>")],
    });

    const result = await crawl("https://docs.example/", { fetchOptions: { resolver, fetchImpl } });

    expect(requested).not.toContain("/private/x");
    expect(result.pages.map((p) => new URL(p.url).pathname).sort()).toEqual(["/", "/public"]);
  });

  it("waits between requests when the site asked it to", async () => {
    const waits: number[] = [];
    const { fetchImpl } = site({
      "/robots.txt": ["text/plain", "User-agent: *\nCrawl-delay: 1\nDisallow:"],
      "/": ["text/html", html('<a href="/a">a</a>')],
      "/a": ["text/html", html("<p>a</p>")],
    });

    await crawl("https://docs.example/", {
      fetchOptions: { resolver, fetchImpl },
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    expect(waits).toEqual([1000, 1000]);
  });

  it("visits a page once however many links point at it", async () => {
    const { requested, fetchImpl } = site({
      "/robots.txt": ["text/plain", "User-agent: *\nDisallow:"],
      "/": ["text/html", html('<a href="/a">1</a><a href="/a#top">2</a><a href="/a/">3</a>')],
      "/a": ["text/html", html("<p>a</p>")],
    });

    await crawl("https://docs.example/", { fetchOptions: { resolver, fetchImpl } });

    expect(requested.filter((p) => p === "/a")).toHaveLength(1);
  });
});

describe("a crawled link cannot reach a private address", () => {
  it("refuses a link to the metadata endpoint and records it as an error", async () => {
    // The reason the crawler holds no fetch of its own. A page on a site you
    // asked to crawl can link anywhere.
    const { fetchImpl } = site({
      "/robots.txt": ["text/plain", "User-agent: *\nDisallow:"],
      "/": ["text/html", html('<a href="https://metadata.example/latest/meta-data/">x</a>')],
    });

    const result = await crawl("https://docs.example/", {
      allowHosts: ["docs.example", "metadata.example"],
      fetchOptions: {
        fetchImpl,
        resolver: async (host) => [
          {
            address: host === "metadata.example" ? "169.254.169.254" : "93.184.216.34",
            family: 4,
          },
        ],
      },
    });

    expect(result.pages.map((p) => new URL(p.url).hostname)).toEqual(["docs.example"]);
    expect(result.errors.some((e) => e.reason === "blocked_address")).toBe(true);
  });
});

describe("per-document errors are surfaced, not swallowed", () => {
  it("records a 404 and keeps crawling", async () => {
    // "38 of 412 documents failed" is a report. A silent partial index is an
    // incident waiting to happen.
    const { fetchImpl } = site({
      "/robots.txt": ["text/plain", "User-agent: *\nDisallow:"],
      "/": ["text/html", html('<a href="/gone">gone</a><a href="/here">here</a>')],
      "/here": ["text/html", html("<p>here</p>")],
    });

    const result = await crawl("https://docs.example/", { fetchOptions: { resolver, fetchImpl } });

    expect(result.errors).toContainEqual({
      url: "https://docs.example/gone",
      reason: "http_error",
      detail: "status 404",
    });
    expect(result.pages.map((p) => new URL(p.url).pathname).sort()).toEqual(["/", "/here"]);
  });

  it("treats a missing robots.txt as permissive rather than as a blocker", async () => {
    const { fetchImpl } = site({ "/": ["text/html", html("<p>home</p>")] });

    const result = await crawl("https://docs.example/", { fetchOptions: { resolver, fetchImpl } });

    expect(result.pages).toHaveLength(1);
  });
});

describe("url handling", () => {
  it("drops the fragment, because /docs#install is the same document as /docs", () => {
    expect(normalise("https://x.example/docs#install")).toBe("https://x.example/docs");
  });

  it("keeps the query string, which routinely selects real content", () => {
    expect(normalise("https://x.example/search?q=refund")).toBe(
      "https://x.example/search?q=refund",
    );
  });

  it("ignores anchors that are not navigation", () => {
    const links = extractLinks(
      html('<a href="#top">t</a><a href="mailto:x@y.z">m</a><a href="/real">r</a>'),
      "https://x.example/",
    );

    expect(links).toEqual(["https://x.example/real"]);
  });

  it("reads sitemap entries without parsing XML", () => {
    // A sitemap is attacker-influenced XML; not parsing it as XML means there
    // is no XXE surface here at all.
    const urls = extractSitemapUrls(
      "<urlset><url><loc>https://x.example/a</loc></url><url><loc>https://x.example/b</loc></url></urlset>",
    );

    expect(urls).toEqual(["https://x.example/a", "https://x.example/b"]);
  });
});
