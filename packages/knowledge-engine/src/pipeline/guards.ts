/**
 * Malicious-document defences (threat-model §T6).
 *
 * A document is untrusted input that happens to be large and structured. The
 * controls here are all about the same thing: never let a parser be told how
 * much work to do by the file it is parsing.
 *
 * Everything is a limit with a number attached, and every number is checked
 * *before* the expensive operation rather than during it. A zip bomb is only a
 * bomb because the decision to keep going is made by the archive.
 */

export type DocumentDenial =
  | { readonly reason: "too_large"; readonly detail: string }
  | { readonly reason: "unsupported_type"; readonly detail: string }
  | { readonly reason: "archive_bomb"; readonly detail: string }
  | { readonly reason: "xxe"; readonly detail: string }
  | { readonly reason: "active_content"; readonly detail: string }
  | { readonly reason: "timeout"; readonly detail: string };

export type DocumentCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly denial: DocumentDenial };

const pass: DocumentCheck = { ok: true };
const deny = (reason: DocumentDenial["reason"], detail: string): DocumentCheck => ({
  ok: false,
  denial: { reason, detail } as DocumentDenial,
});

export const LIMITS = {
  /** Per file. Anything larger is an ingestion job, not a document. */
  maxBytes: 25 * 1024 * 1024,
  /** Decompressed size across an archive. */
  maxArchiveBytes: 100 * 1024 * 1024,
  /** Compression ratio above which a file is a bomb, not a document. */
  maxCompressionRatio: 100,
  maxArchiveEntries: 1_000,
  /** Wall clock for one document's parse. */
  parseTimeoutMs: 30_000,
} as const;

export const SUPPORTED_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/markdown",
  "text/plain",
  "text/html",
  "text/csv",
  "application/json",
] as const;

export type SupportedType = (typeof SUPPORTED_TYPES)[number];

export function checkSize(bytes: number): DocumentCheck {
  return bytes > LIMITS.maxBytes
    ? deny("too_large", `${bytes} bytes exceeds the ${LIMITS.maxBytes} byte limit`)
    : pass;
}

/**
 * SVG is rejected outright rather than sanitised.
 *
 * Sanitising SVG means keeping up with every way script can be smuggled into
 * it, forever, against an attacker who only needs to win once. Nothing in the
 * knowledge pipeline needs to read SVG, so the cheap answer is the right one.
 */
export function checkType(contentType: string): DocumentCheck {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "image/svg+xml") {
    return deny("active_content", "SVG is not accepted: it is a script container");
  }
  return (SUPPORTED_TYPES as readonly string[]).includes(type)
    ? pass
    : deny("unsupported_type", `${type} is not a supported document type`);
}

/**
 * Judges an archive before extracting it.
 *
 * Both the declared total and the ratio, because either alone is bypassable: a
 * 42 KB zip that expands to 4.5 PB fails on ratio, and a bomb assembled from
 * many mildly-compressed entries fails on total.
 */
export function checkArchive(
  entries: readonly { readonly compressedSize: number; readonly uncompressedSize: number }[],
): DocumentCheck {
  if (entries.length > LIMITS.maxArchiveEntries) {
    return deny("archive_bomb", `${entries.length} entries exceeds ${LIMITS.maxArchiveEntries}`);
  }

  let total = 0;
  for (const entry of entries) {
    total += entry.uncompressedSize;
    if (total > LIMITS.maxArchiveBytes) {
      return deny("archive_bomb", `expands to more than ${LIMITS.maxArchiveBytes} bytes`);
    }
    // A zero-length compressed entry claiming a large size is the degenerate
    // case; treating it as ratio-infinite is correct.
    const ratio =
      entry.compressedSize === 0
        ? Number.POSITIVE_INFINITY
        : entry.uncompressedSize / entry.compressedSize;
    if (ratio > LIMITS.maxCompressionRatio) {
      return deny("archive_bomb", `compression ratio ${Math.round(ratio)}:1 is implausible`);
    }
  }

  return pass;
}

/**
 * Refuses XML that declares entities or an external DTD.
 *
 * Done by inspection before parsing rather than by configuring the parser,
 * because "we disabled that flag" is a claim about one parser on one day. DOCX
 * is a zip of XML, so this runs on every office document too.
 */
export function checkXml(xml: string): DocumentCheck {
  const head = xml.slice(0, 8192);

  if (/<!ENTITY/i.test(head)) {
    return deny("xxe", "the document declares XML entities");
  }
  if (/<!DOCTYPE[^>]*(SYSTEM|PUBLIC)/i.test(head)) {
    return deny("xxe", "the document references an external DTD");
  }
  return pass;
}

/**
 * Refuses a PDF carrying active content.
 *
 * `/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile` and `/OpenAction` are the
 * markers that matter. Nothing in a knowledge base needs a PDF that runs when
 * opened, so this is a refusal rather than a strip: stripping means trusting
 * that the strip was complete.
 */
export function checkPdf(bytes: Uint8Array): DocumentCheck {
  const text = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 2 * 1024 * 1024))).toString(
    "latin1",
  );

  for (const marker of ["/JavaScript", "/JS ", "/Launch", "/OpenAction", "/EmbeddedFile"]) {
    if (text.includes(marker)) {
      return deny("active_content", `the PDF contains ${marker.trim()}`);
    }
  }
  return pass;
}

/**
 * Runs a parse under a wall clock.
 *
 * A parser that hangs on a crafted file is a denial of service that costs the
 * attacker one upload. The timeout is not negotiable per document, because the
 * document is the thing that would be negotiating.
 */
export async function withParseTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = LIMITS.parseTimeoutMs,
): Promise<{ ok: true; value: T } | { ok: false; denial: DocumentDenial }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const value = await Promise.race([
      work(controller.signal),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("parse timeout")), {
          once: true,
        });
      }),
    ]);
    return { ok: true, value };
  } catch (cause) {
    if (controller.signal.aborted) {
      return { ok: false, denial: { reason: "timeout", detail: `parse exceeded ${timeoutMs}ms` } };
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}
