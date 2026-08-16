import { unzipSync } from "fflate";
import TurndownService from "turndown";
import { extractText, getDocumentProxy } from "unpdf";
import {
  checkArchive,
  checkPdf,
  checkSize,
  checkXml,
  type DocumentDenial,
  LIMITS,
} from "../pipeline/guards.js";

/**
 * Format-specific extraction (doc 03 §A1).
 *
 * Every parser here produces markdown, because markdown is what the chunker
 * understands and because heading structure is the one thing that must survive
 * extraction — a parser that returns a wall of text has thrown away the
 * information the citation depends on.
 *
 * Every parser also runs its guards *first*. That ordering is the control: a
 * zip bomb is only a bomb because the decision to keep going is made by the
 * archive, and a PDF's JavaScript only matters if something opens the PDF.
 *
 * Parsed text is `external` integrity by definition (threat-model §T6). Nothing
 * here decides what to do about that; it is the caller's job, and it is why the
 * return type says nothing about trust.
 */

export type ParseResult =
  | { readonly ok: true; readonly markdown: string; readonly title: string | null }
  | { readonly ok: false; readonly denial: DocumentDenial };

const denied = (denial: DocumentDenial): ParseResult => ({ ok: false, denial });

/* ---------------------------------------------------------------- text -- */

export function parseText(bytes: Uint8Array): ParseResult {
  const size = checkSize(bytes.byteLength);
  if (!size.ok) return denied(size.denial);

  return { ok: true, markdown: new TextDecoder().decode(bytes), title: null };
}

export function parseMarkdown(bytes: Uint8Array): ParseResult {
  const parsed = parseText(bytes);
  if (!parsed.ok) return parsed;

  // The first h1 is the document's title when it has one; falling back to the
  // filename is the caller's decision, not this function's invention.
  const heading = /^#\s+(.+)$/m.exec(parsed.markdown);
  return { ok: true, markdown: parsed.markdown, title: heading?.[1]?.trim() ?? null };
}

/* ---------------------------------------------------------------- json -- */

/**
 * JSON becomes a heading-per-key outline rather than a pretty-printed blob.
 *
 * A blob chunks into fragments that retrieve terribly: `"status": "active"`
 * carries no indication of what is active. The outline gives every leaf a
 * heading path, which is what makes the chunk citable.
 */
export function parseJson(bytes: Uint8Array): ParseResult {
  const parsed = parseText(bytes);
  if (!parsed.ok) return parsed;

  let value: unknown;
  try {
    value = JSON.parse(parsed.markdown);
  } catch {
    return denied({ reason: "unsupported_type", detail: "the file is not valid JSON" });
  }

  return { ok: true, markdown: outline(value, 1).trim(), title: null };
}

function outline(value: unknown, depth: number): string {
  if (value === null || typeof value !== "object") return `${String(value)}\n`;

  if (Array.isArray(value)) {
    return value
      .map((item, i) => `${"#".repeat(Math.min(depth, 6))} [${i}]\n\n${outline(item, depth + 1)}`)
      .join("\n");
  }

  return Object.entries(value)
    .map(([key, v]) =>
      v === null || typeof v !== "object"
        ? `- **${key}**: ${String(v)}\n`
        : `${"#".repeat(Math.min(depth, 6))} ${key}\n\n${outline(v, depth + 1)}`,
    )
    .join("\n");
}

/* ----------------------------------------------------------------- csv -- */

/**
 * CSV becomes one markdown table, which the chunker keeps whole.
 *
 * The header row is repeated into every chunk a large table produces, because
 * a chunk of rows without its header is a grid of numbers with no meaning.
 */
export function parseCsv(bytes: Uint8Array, rowsPerTable = 50): ParseResult {
  const parsed = parseText(bytes);
  if (!parsed.ok) return parsed;

  const rows = parsed.markdown
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map(splitCsvLine);

  const header = rows[0];
  if (header === undefined) return { ok: true, markdown: "", title: null };

  const body = rows.slice(1);
  const tables: string[] = [];

  for (let i = 0; i < body.length; i += rowsPerTable) {
    const slice = body.slice(i, i + rowsPerTable);
    tables.push(
      [
        `| ${header.join(" | ")} |`,
        `| ${header.map(() => "---").join(" | ")} |`,
        ...slice.map((r) => `| ${r.join(" | ")} |`),
      ].join("\n"),
    );
  }

  return { ok: true, markdown: tables.join("\n\n"), title: null };
}

/** Handles quoted fields and embedded commas. Not a full RFC 4180 parser. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(field.trim());
      field = "";
    } else field += c;
  }

  out.push(field.trim());
  // Pipes would break the markdown table this becomes.
  return out.map((f) => f.replace(/\|/g, "\\|"));
}

/* ---------------------------------------------------------------- html -- */

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
// Script and style are not content, and their text is actively harmful in a
// knowledge base: it retrieves as prose and embeds as noise.
turndown.remove(["script", "style", "noscript", "iframe", "svg"]);

export function parseHtml(bytes: Uint8Array): ParseResult {
  const parsed = parseText(bytes);
  if (!parsed.ok) return parsed;

  const html = parsed.markdown;
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? null;

  // Chrome, nav and footer are boilerplate on every page of a docs site, and
  // leaving them in means every chunk shares the same noise — which is exactly
  // the noise that makes embeddings of different pages look similar.
  const stripped = html
    .replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  return { ok: true, markdown: turndown.turndown(stripped).trim(), title };
}

/* ----------------------------------------------------------------- pdf -- */

/**
 * PDF text extraction via pdf.js (through unpdf's serverless build).
 *
 * A hand-rolled extractor was the alternative and is the wrong call: it would
 * handle uncompressed and FlateDecode streams and silently miss everything
 * else, producing a knowledge base that is *confidently* missing content. A
 * noisy knowledge base gives bad answers; a silently-incomplete one gives
 * confident wrong ones.
 *
 * On active content: the guard refuses any document carrying /JavaScript,
 * /Launch or /OpenAction before the file is opened at all. Beyond that, the
 * extraction API used here never executes document scripts — pdf.js only runs
 * them when the *viewer's* scripting layer is enabled, and no viewer is
 * involved. There is deliberately no "disable eval" option passed: this build
 * exposes none, and passing a flag that does not exist would read as a control
 * while doing nothing.
 */
export async function parsePdf(bytes: Uint8Array): Promise<ParseResult> {
  const size = checkSize(bytes.byteLength);
  if (!size.ok) return denied(size.denial);

  const active = checkPdf(bytes);
  if (!active.ok) return denied(active.denial);

  try {
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [String(text)];

    // Page boundaries are preserved as headings. Without them a 300-page manual
    // chunks into fragments nobody can locate in the original.
    const markdown = pages
      .map((page, i) => `## Page ${i + 1}\n\n${page.trim()}`)
      .filter((page) => page.split("\n\n")[1] !== "")
      .join("\n\n");

    return { ok: true, markdown, title: null };
  } catch (cause) {
    // A password-protected or corrupt PDF is a per-document error, reported as
    // such rather than failing the whole source (doc 03 §A3).
    return denied({
      reason: "unsupported_type",
      detail: cause instanceof Error ? cause.message : "the PDF could not be read",
    });
  }
}

/* ---------------------------------------------------------------- docx -- */

/**
 * DOCX, unzipped and read directly rather than through a conversion library.
 *
 * Deliberate: DOCX is a zip of XML, and doing it here means the archive-bomb
 * guard runs on the real entry table *before* anything is decompressed, and the
 * XXE check runs on the actual document.xml bytes. A library would decompress
 * first and hand us the result, which is the wrong order for both controls.
 */
export function parseDocx(bytes: Uint8Array): ParseResult {
  const size = checkSize(bytes.byteLength);
  if (!size.ok) return denied(size.denial);

  // The bomb check runs inside the filter, which fflate calls *before* it
  // inflates each entry. Checking afterwards would mean the bomb had already
  // expanded in memory — the guard would report an attack it had just suffered.
  const entries: { compressedSize: number; uncompressedSize: number }[] = [];
  let bomb: DocumentDenial | null = null;
  let expanded = 0;

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        entries.push({ compressedSize: file.size, uncompressedSize: file.originalSize });
        expanded += file.originalSize;

        const verdict = checkArchive(entries);
        if (!verdict.ok) {
          bomb ??= verdict.denial;
          return false;
        }
        // Only the one entry that matters is inflated at all. A DOCX carries
        // dozens of parts and none of the others is read here.
        return file.name === "word/document.xml" && expanded <= LIMITS.maxArchiveBytes;
      },
    });
  } catch {
    return denied({ reason: "unsupported_type", detail: "the file is not a readable archive" });
  }

  if (bomb !== null) return denied(bomb);

  const documentXml = files["word/document.xml"];
  if (documentXml === undefined) {
    return denied({ reason: "unsupported_type", detail: "no word/document.xml in the archive" });
  }

  const xml = new TextDecoder().decode(documentXml);
  const xxe = checkXml(xml);
  if (!xxe.ok) return denied(xxe.denial);

  return { ok: true, markdown: docxToMarkdown(xml), title: null };
}

/**
 * Turns WordprocessingML into markdown, keeping headings.
 *
 * Only headings, paragraphs and runs. Everything else is dropped rather than
 * approximated: a wrong heading level is worse than none, because the heading
 * path is what a citation points at.
 */
export function docxToMarkdown(xml: string): string {
  const paragraphs = xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? [];

  return paragraphs
    .map((p) => {
      const text = (p.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) ?? [])
        .map((t) => t.replace(/<[^>]+>/g, ""))
        .join("")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .trim();

      if (text === "") return "";

      const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(p)?.[1] ?? "";
      const heading = /^Heading(\d)$/i.exec(style);
      if (heading !== null) {
        const level = Math.min(Number(heading[1] ?? 1), 6);
        return `${"#".repeat(level)} ${text}`;
      }

      return text;
    })
    .filter((line) => line !== "")
    .join("\n\n");
}

/* -------------------------------------------------------------- routing -- */

export async function parseDocument(contentType: string, bytes: Uint8Array): Promise<ParseResult> {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";

  switch (type) {
    case "application/pdf":
      return parsePdf(bytes);
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return parseDocx(bytes);
    case "text/html":
      return parseHtml(bytes);
    case "text/csv":
      return parseCsv(bytes);
    case "application/json":
      return parseJson(bytes);
    case "text/markdown":
      return parseMarkdown(bytes);
    case "text/plain":
      return parseText(bytes);
    default:
      return denied({ reason: "unsupported_type", detail: `${type} is not supported` });
  }
}
