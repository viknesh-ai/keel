import { z } from "zod";
import { readPath } from "./idempotency.js";

/**
 * The Verification Engine (doc 01 §4.2).
 *
 * Post-conditions on mutations: after `update_subscription`, read back and
 * confirm. Cheap, deterministic, and aimed at one specific failure mode — the
 * model saying it worked. A 200 response is evidence that a request was
 * accepted, not that the state the user cares about actually changed, and the
 * gap between those two is where "I cancelled it for you" gets said about a
 * subscription that is still billing.
 *
 * Deliberately not clever: it compares declared paths to declared values. There
 * is no model in this path, because a check that can be talked out of failing
 * is not a check.
 */

export const postConditionSchema = z.object({
  /** The read-only tool to call back. */
  read: z.string().min(1),
  /** Arguments for the read, as paths into the mutation's arguments. */
  args_from: z.record(z.string(), z.string()).default({}),
  /** Path into the read's result. */
  path: z.string().min(1),
  /**
   * What it must equal. Either a literal or a path into the mutation's
   * arguments, so "the plan is now what we asked for" is expressible.
   */
  equals: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  equals_arg: z.string().min(1).optional(),
  description: z.string().min(1).max(200),
});

export type PostCondition = z.infer<typeof postConditionSchema>;

export type VerificationOutcome =
  | { readonly ok: true; readonly checked: number }
  | {
      readonly ok: false;
      readonly failures: readonly {
        readonly description: string;
        readonly path: string;
        readonly expected: unknown;
        readonly actual: unknown;
      }[];
    };

export type ReadBack = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Runs every declared post-condition.
 *
 * All of them, not the first failure: an operator reading a trace wants to know
 * everything that is wrong with the state, and stopping at the first check
 * turns one investigation into three.
 */
export async function verifyPostConditions(
  conditions: readonly PostCondition[],
  input: { readonly args: Record<string, unknown>; readonly readBack: ReadBack },
): Promise<VerificationOutcome> {
  const failures: {
    description: string;
    path: string;
    expected: unknown;
    actual: unknown;
  }[] = [];

  for (const condition of conditions) {
    const readArgs: Record<string, unknown> = {};
    for (const [name, path] of Object.entries(condition.args_from)) {
      readArgs[name] = readPath(input.args, path as string);
    }

    const result = await input.readBack(condition.read, readArgs);
    const actual = readPath(result, condition.path);
    const expected =
      condition.equals_arg === undefined
        ? condition.equals
        : readPath(input.args, condition.equals_arg);

    // Strict equality on scalars. A loose comparison here would let "0" pass
    // for 0 and false pass for null, which is precisely the kind of nearly-right
    // that a verification step exists to catch.
    if (actual !== expected) {
      failures.push({ description: condition.description, path: condition.path, expected, actual });
    }
  }

  return failures.length === 0 ? { ok: true, checked: conditions.length } : { ok: false, failures };
}

/**
 * Turns a failed verification into the sentence a user sees.
 *
 * Never "done!". A mutation whose post-condition failed did something unknown,
 * and saying so plainly is the only honest option — the alternative is a
 * confident summary of a change that did not happen.
 */
export function describeVerificationFailure(outcome: VerificationOutcome): string {
  if (outcome.ok) return "";
  const first = outcome.failures[0];
  const rest = outcome.failures.length - 1;
  const tail = rest > 0 ? ` (and ${rest} other check${rest === 1 ? "" : "s"})` : "";
  return `The change could not be confirmed: ${first?.description ?? "a post-condition failed"}${tail}.`;
}
