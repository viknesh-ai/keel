/**
 * Redaction for step payloads (doc 05 §E5).
 *
 * The trace screen shows real inputs and outputs, which is the point — but a
 * payload can carry a token, a key or a header that must not be rendered even
 * to an operator who is entitled to see the run. CLAUDE.md hard rule 4 says a
 * secret never reaches a log, a trace or model context; this is the trace half.
 *
 * Redacted fields are *marked*, not silently dropped. An operator debugging a
 * failed call needs to know an authorization header was present and had a
 * plausible shape — deleting the key entirely makes the trace lie by omission.
 */

export const REDACTED = "‹redacted›";

const SENSITIVE_KEY =
  /^(authorization|cookie|set-cookie|x-api-key|api[-_]?key|secret|password|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|private[-_]?key|signature)$/i;

/** Values that look like credentials wherever they appear. */
const SENSITIVE_VALUE = [
  /^Bearer\s+\S+/i,
  /^sk-[A-Za-z0-9]{16,}/,
  /^gh[pousr]_[A-Za-z0-9]{20,}/,
  /^-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./,
];

export type Redaction = { readonly path: string; readonly reason: "key" | "value" };

export type RedactResult = {
  readonly value: unknown;
  readonly redactions: readonly Redaction[];
};

export function redact(input: unknown): RedactResult {
  const redactions: Redaction[] = [];

  const walk = (node: unknown, path: string, depth: number): unknown => {
    // A payload deep enough to blow the stack is a payload we do not render.
    if (depth > 32) return REDACTED;
    if (node === null || node === undefined) return node;

    if (typeof node === "string") {
      if (SENSITIVE_VALUE.some((pattern) => pattern.test(node))) {
        redactions.push({ path, reason: "value" });
        return REDACTED;
      }
      return node;
    }

    if (Array.isArray(node)) return node.map((item, i) => walk(item, `${path}[${i}]`, depth + 1));

    if (typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([key, value]) => {
          const childPath = path === "" ? key : `${path}.${key}`;
          if (SENSITIVE_KEY.test(key)) {
            redactions.push({ path: childPath, reason: "key" });
            return [key, REDACTED];
          }
          return [key, walk(value, childPath, depth + 1)];
        }),
      );
    }

    return node;
  };

  return { value: walk(input, "", 0), redactions };
}
