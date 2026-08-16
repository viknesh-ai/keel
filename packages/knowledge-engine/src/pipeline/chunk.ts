import { createHash } from "node:crypto";

/**
 * Structure-aware chunking (doc 03 §A1).
 *
 * Two properties the naive version gets wrong.
 *
 * First, the heading path. A chunk that arrives at the model as an anonymous
 * fragment is one the user cannot be shown a citation for, and one the model
 * cannot tell apart from a similar fragment elsewhere in the document.
 * "Billing → Refunds → Eligibility" is the difference between a citation and a
 * shrug.
 *
 * Second, structures that must not be cut. A code fence split down the middle
 * is worse than useless — it retrieves as prose, embeds as noise, and if the
 * model repeats it the user gets something that does not run. Table rows and
 * list items have the same problem in a quieter way.
 */

export type Chunk = {
  readonly seq: number;
  readonly content: string;
  readonly contentSha256: string;
  readonly headingPath: readonly string[];
  readonly tokenCount: number;
};

export type ChunkOptions = {
  /** Target size in tokens. Approximated by words; see `countTokens`. */
  readonly maxTokens?: number;
  readonly overlapTokens?: number;
};

const DEFAULTS = { maxTokens: 400, overlapTokens: 40 };

/**
 * A word-count approximation, and deliberately not a real tokenizer.
 *
 * A tokenizer would tie chunking to one model's vocabulary, which is exactly
 * the coupling the stage-addressable design exists to avoid: changing the
 * embedding model would then force a re-chunk, and re-chunking is the expensive
 * stage. The approximation runs about 25% low against BPE for English prose,
 * which the default target already allows for.
 */
export function countTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
}

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

type Block = {
  readonly text: string;
  readonly headings: readonly string[];
  readonly atomic: boolean;
};

/**
 * Splits markdown into blocks, tracking the heading path and marking the
 * blocks that must survive intact.
 */
export function toBlocks(markdown: string): readonly Block[] {
  const blocks: Block[] = [];
  const headings: string[] = [];
  const lines = markdown.split("\n");

  let buffer: string[] = [];
  let inFence = false;
  let fenceMarker = "";

  const flush = (atomic = false) => {
    const text = buffer.join("\n").trim();
    buffer = [];
    if (text !== "") blocks.push({ text, headings: [...headings], atomic });
  };

  for (const line of lines) {
    const fence = /^\s*(```|~~~)/.exec(line);

    if (inFence) {
      buffer.push(line);
      if (fence !== null && line.trim().startsWith(fenceMarker)) {
        inFence = false;
        // Atomic: a fence cut in half retrieves as prose and, repeated back,
        // gives the user something that does not run.
        flush(true);
      }
      continue;
    }

    if (fence !== null) {
      flush();
      inFence = true;
      fenceMarker = fence[1] ?? "```";
      buffer.push(line);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flush();
      const depth = (heading[1] ?? "#").length;
      headings.length = Math.min(headings.length, depth - 1);
      while (headings.length < depth - 1) headings.push("");
      headings[depth - 1] = (heading[2] ?? "").trim();
      headings.length = depth;
      continue;
    }

    // A table is kept whole for the same reason as a fence: half a table has
    // lost the header row that gives its columns meaning.
    if (line.trim() === "" && buffer.length > 0) {
      flush(buffer.some((l) => l.trim().startsWith("|")));
      continue;
    }

    buffer.push(line);
  }

  // An unterminated fence is a malformed document, not a reason to lose the
  // rest of it.
  flush(inFence);
  return blocks;
}

/**
 * Chunks a document.
 *
 * Blocks are packed up to the token budget and split on block boundaries, so a
 * chunk is always a whole number of paragraphs unless a single block is itself
 * over budget. An atomic block over budget is emitted alone and oversized —
 * deliberately, because the alternative is cutting it.
 */
export function chunkMarkdown(markdown: string, options: ChunkOptions = {}): readonly Chunk[] {
  const maxTokens = options.maxTokens ?? DEFAULTS.maxTokens;
  const overlapTokens = options.overlapTokens ?? DEFAULTS.overlapTokens;

  const chunks: Chunk[] = [];
  let pending: Block[] = [];
  let pendingTokens = 0;

  const emit = () => {
    if (pending.length === 0) return;
    const content = pending.map((b) => b.text).join("\n\n");
    const first = pending[0];
    chunks.push({
      seq: chunks.length,
      content,
      contentSha256: sha(content),
      headingPath: (first?.headings ?? []).filter((h) => h !== ""),
      tokenCount: countTokens(content),
    });
    pending = [];
    pendingTokens = 0;
  };

  const samePath = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((v, i) => v === b[i]);

  for (const block of toBlocks(markdown)) {
    const tokens = countTokens(block.text);

    // A chunk never spans a heading boundary. Packing across one would give the
    // chunk a heading path that is wrong for part of its own content — and the
    // path is what the citation shows the user, so a wrong one sends them to
    // the wrong section of the document.
    const current = pending[0];
    if (current !== undefined && !samePath(current.headings, block.headings)) emit();

    if (pendingTokens + tokens > maxTokens && pending.length > 0) {
      const tail = pending.at(-1);
      emit();
      // Small overlap, carrying the previous block when it is cheap enough to
      // be worth it. A question whose answer straddles a boundary otherwise
      // retrieves half of itself.
      if (tail !== undefined && countTokens(tail.text) <= overlapTokens) {
        pending = [tail];
        pendingTokens = countTokens(tail.text);
      }
    }

    if (tokens > maxTokens && block.atomic) {
      emit();
      pending = [block];
      pendingTokens = tokens;
      emit();
      continue;
    }

    pending.push(block);
    pendingTokens += tokens;
  }

  emit();
  return chunks;
}
