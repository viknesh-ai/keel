import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  docxToMarkdown,
  parseCsv,
  parseDocument,
  parseDocx,
  parseHtml,
  parseJson,
  parseMarkdown,
} from "../src/parse/parsers.js";
import { chunkMarkdown } from "../src/pipeline/chunk.js";

/**
 * Format-specific extraction (doc 03 §A1, threat-model §T6).
 *
 * Every parser produces markdown, so the assertions are mostly about *structure
 * surviving* — headings above all, because the heading path is what a citation
 * points at and a parser that returns a wall of text has thrown it away.
 *
 * The archive tests build real zips with fflate rather than fixtures, so the
 * bomb under test is an actual bomb and the guard is doing actual work.
 */

const bytes = (text: string) => new TextEncoder().encode(text);

describe("markdown and text", () => {
  it("takes the title from the first h1", () => {
    const result = parseMarkdown(bytes("# Billing guide\n\nSome content."));

    expect(result.ok && result.title).toBe("Billing guide");
  });

  it("returns no title rather than inventing one", () => {
    // Falling back to the filename is the caller's decision. A parser that
    // guesses produces titles nobody wrote.
    const result = parseMarkdown(bytes("Just a paragraph."));

    expect(result.ok && result.title).toBeNull();
  });
});

describe("html", () => {
  const PAGE = `<!doctype html><html><head><title>Refund policy</title></head>
    <body>
      <nav><a href="/home">Home</a><a href="/docs">Docs</a></nav>
      <h1>Refunds</h1>
      <p>Refunds are processed within <strong>14 days</strong>.</p>
      <h2>Eligibility</h2>
      <p>Orders under 90 days old qualify.</p>
      <script>window.track('pageview');</script>
      <footer>Copyright 2026</footer>
    </body></html>`;

  it("keeps the heading structure the chunker depends on", () => {
    const result = parseHtml(bytes(PAGE));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toContain("# Refunds");
    expect(result.markdown).toContain("## Eligibility");
  });

  it("drops script text, which retrieves as prose and embeds as noise", () => {
    const result = parseHtml(bytes(PAGE));

    expect(result.ok && result.markdown).not.toContain("pageview");
  });

  it("drops nav and footer, which are the same on every page of a docs site", () => {
    // Boilerplate in every chunk is exactly the noise that makes embeddings of
    // different pages look similar to each other.
    const result = parseHtml(bytes(PAGE));

    expect(result.ok && result.markdown).not.toContain("Copyright 2026");
    expect(result.ok && result.markdown).not.toContain("Home");
  });

  it("takes the title from <title>", () => {
    const result = parseHtml(bytes(PAGE));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.title).toBe("Refund policy");
  });

  it("produces chunks with correct heading paths end to end", () => {
    // The session's exit criterion, through the real pipeline rather than a
    // hand-written markdown fixture.
    const parsed = parseHtml(bytes(PAGE));
    if (!parsed.ok) throw new Error("parse failed");

    const chunks = chunkMarkdown(parsed.markdown, { maxTokens: 20 });
    const eligibility = chunks.find((c) => c.content.includes("90 days"));

    expect(eligibility?.headingPath).toEqual(["Refunds", "Eligibility"]);
  });
});

describe("csv", () => {
  const CSV = `plan,price,seats\nPro,40,10\n"Team, annual",90,50\n`;

  it("becomes a markdown table the chunker keeps whole", () => {
    const result = parseCsv(bytes(CSV));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toContain("| plan | price | seats |");
    expect(result.markdown).toContain("| Pro | 40 | 10 |");
  });

  it("handles a quoted field containing a comma", () => {
    const result = parseCsv(bytes(CSV));

    expect(result.ok && result.markdown).toContain("| Team, annual | 90 | 50 |");
  });

  it("repeats the header into every table when the rows are split", () => {
    // A chunk of rows without its header is a grid of numbers with no meaning.
    const many = ["id,name", ...Array.from({ length: 5 }, (_v, i) => `${i},row${i}`)].join("\n");
    const result = parseCsv(bytes(many), 2);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown.match(/\| id \| name \|/g)).toHaveLength(3);
  });

  it("escapes pipes, which would otherwise break the table it becomes", () => {
    const result = parseCsv(bytes("a,b\nx|y,z"));

    expect(result.ok && result.markdown).toContain("x\\|y");
  });
});

describe("json", () => {
  it("becomes a heading outline rather than a pretty-printed blob", () => {
    // `"status": "active"` in a blob carries no indication of what is active.
    const result = parseJson(bytes(JSON.stringify({ billing: { status: "active", plan: "pro" } })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toContain("# billing");
    expect(result.markdown).toContain("**status**: active");
  });

  it("reports invalid JSON rather than throwing", () => {
    const result = parseJson(bytes("{not json"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denial.reason).toBe("unsupported_type");
  });
});

describe("docx", () => {
  const documentXml = `<?xml version="1.0"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Billing</w:t></w:r></w:p>
        <w:p><w:r><w:t>Refunds take </w:t></w:r><w:r><w:t>14 days.</w:t></w:r></w:p>
        <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Eligibility</w:t></w:r></w:p>
        <w:p><w:r><w:t>Under 90 days &amp; unopened.</w:t></w:r></w:p>
      </w:body>
    </w:document>`;

  const makeDocx = (xml: string) =>
    zipSync({ "word/document.xml": strToU8(xml), "[Content_Types].xml": strToU8("<Types/>") });

  it("keeps heading levels, because a wrong level misfiles the citation", () => {
    const result = parseDocx(makeDocx(documentXml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toContain("# Billing");
    expect(result.markdown).toContain("## Eligibility");
  });

  it("joins runs, which Word splits mid-sentence for its own reasons", () => {
    const result = parseDocx(makeDocx(documentXml));

    expect(result.ok && result.markdown).toContain("Refunds take 14 days.");
  });

  it("decodes entities", () => {
    expect(docxToMarkdown(documentXml)).toContain("Under 90 days & unopened.");
  });

  it("rejects a DOCX whose XML declares entities", () => {
    // DOCX is a zip of XML, so XXE is reachable here just as it is in a bare
    // XML upload.
    const xxe = `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><w:document xmlns:w="w"><w:body/></w:document>`;
    const result = parseDocx(makeDocx(xxe));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denial.reason).toBe("xxe");
  });

  it("rejects a real zip bomb before inflating it", () => {
    // A megabyte of zeroes compresses to almost nothing, which is the ratio a
    // bomb relies on. Built for real rather than mocked, so the guard is doing
    // actual work against actual compression.
    const zeroes = new Uint8Array(4 * 1024 * 1024);
    const bomb = zipSync({ "word/document.xml": zeroes }, { level: 9 });

    const result = parseDocx(bomb);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denial.reason).toBe("archive_bomb");
  });

  it("reports a file that is not an archive at all", () => {
    const result = parseDocx(bytes("this is not a zip"));

    expect(result.ok).toBe(false);
  });

  it("reports a zip with no document.xml", () => {
    const result = parseDocx(zipSync({ "other.xml": strToU8("<x/>") }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denial.detail).toContain("word/document.xml");
  });
});

describe("routing", () => {
  it("dispatches on content type", async () => {
    const result = await parseDocument("text/markdown; charset=utf-8", bytes("# Hi"));

    expect(result.ok && result.title).toBe("Hi");
  });

  it("refuses a type nobody asked for", async () => {
    const result = await parseDocument("application/x-msdownload", bytes("MZ"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denial.reason).toBe("unsupported_type");
  });

  it("refuses a PDF carrying active content before opening it", async () => {
    const result = await parseDocument(
      "application/pdf",
      bytes("%PDF-1.7\n/OpenAction << /JS (app.alert(1)) >>"),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denial.reason).toBe("active_content");
  });

  it("reports an unreadable PDF as a per-document error, not a crash", async () => {
    // A password-protected or corrupt PDF must fail this document and no more:
    // 31 bad PDFs out of 412 is a report, not an outage.
    const result = await parseDocument("application/pdf", bytes("%PDF-1.7 truncated"));

    expect(result.ok).toBe(false);
  });
});
