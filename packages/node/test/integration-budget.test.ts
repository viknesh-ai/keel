import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The adoption budget from doc 02 §2.1.
 *
 * "Done when ... the demo-saas middleware is under 40 lines. If it's longer,
 * simplify the design — adoption depends on it being trivial."
 *
 * Asserted rather than claimed, because this is the number that decides whether
 * a customer uses action tokens or reaches for a shared service key. If a future
 * change pushes the integration over, that is a signal to move complexity into
 * @keel/node, not to raise the budget.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function codeLines(path: string): number {
  const source = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return source.split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("//"))
    .length;
}

describe("the customer-facing integration stays trivial", () => {
  it("is under 40 lines of code in apps/demo-saas", () => {
    const lines = codeLines(join(root, "apps", "demo-saas", "src", "keel-verifier.ts"));

    expect(lines).toBeLessThanOrEqual(40);
  });
});
