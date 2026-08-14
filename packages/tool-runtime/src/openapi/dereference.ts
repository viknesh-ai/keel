/**
 * `$ref` resolution for OpenAPI documents.
 *
 * Implemented rather than pulled in, for two reasons. The result feeds tool
 * contracts an LLM will be given, so the resolution has to be something we can
 * reason about exactly — and a dereferencer that silently resolves an external
 * or remote `$ref` would turn "import this spec" into "fetch whatever this file
 * points at", which is a network call on a path that has no business making one.
 *
 * Only local `#/...` pointers resolve. Anything else is an error the caller
 * sees, not a silent pass-through.
 */

export type DereferenceIssue = { readonly path: string; readonly message: string };

export type DereferenceResult =
  | { readonly ok: true; readonly document: Record<string, unknown> }
  | { readonly ok: false; readonly issues: readonly DereferenceIssue[] };

const MAX_DEPTH = 64;

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolvePointer(root: unknown, pointer: string): unknown {
  if (pointer === "#" || pointer === "") return root;

  let current: unknown = root;
  for (const raw of pointer.replace(/^#\//, "").split("/")) {
    if (current === null || typeof current !== "object") return undefined;
    const segment = decodePointerSegment(raw);

    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

export function dereference(document: unknown): DereferenceResult {
  if (typeof document !== "object" || document === null) {
    return { ok: false, issues: [{ path: "", message: "document is not an object" }] };
  }

  const issues: DereferenceIssue[] = [];
  const root = document as Record<string, unknown>;

  const walk = (node: unknown, path: string, seen: readonly string[], depth: number): unknown => {
    if (depth > MAX_DEPTH) {
      issues.push({ path, message: "maximum $ref depth exceeded" });
      return node;
    }
    if (node === null || typeof node !== "object") return node;

    if (Array.isArray(node)) {
      return node.map((item, i) => walk(item, `${path}/${i}`, seen, depth + 1));
    }

    const record = node as Record<string, unknown>;
    const ref = record["$ref"];

    if (typeof ref === "string") {
      if (!ref.startsWith("#/")) {
        // A remote or file $ref would mean fetching whatever it points at.
        issues.push({
          path,
          message: `only local $ref pointers are supported, found "${ref}"`,
        });
        return node;
      }

      // A cycle in a schema is legal OpenAPI and common in recursive types.
      // Inlining it forever is not, so the cycle is cut and reported rather
      // than either hanging or silently truncating.
      if (seen.includes(ref)) {
        issues.push({ path, message: `circular $ref: ${ref}` });
        return {};
      }

      const target = resolvePointer(root, ref);
      if (target === undefined) {
        issues.push({ path, message: `unresolved $ref: ${ref}` });
        return node;
      }

      const resolved = walk(target, ref, [...seen, ref], depth + 1);

      // Sibling keys alongside $ref are permitted in OpenAPI 3.1 and act as
      // overrides; dropping them would quietly lose a description.
      const siblings = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "$ref"));
      return typeof resolved === "object" && resolved !== null && !Array.isArray(resolved)
        ? { ...(resolved as Record<string, unknown>), ...siblings }
        : resolved;
    }

    return Object.fromEntries(
      Object.entries(record).map(([key, value]) => [
        key,
        walk(value, `${path}/${key}`, seen, depth + 1),
      ]),
    );
  };

  const result = walk(root, "", [], 0) as Record<string, unknown>;

  return issues.length === 0 ? { ok: true, document: result } : { ok: false, issues };
}
