import type { Comparison } from "./document.js";

/**
 * Argument and attribute matching.
 *
 * Every function here is total: any input produces true or false, never a
 * throw. The evaluator is on the authorization path, and a matcher that can
 * throw turns a malformed argument into a 500 — which, depending on how the
 * caller handles it, can turn into an accidental allow. Returning false is the
 * only safe failure.
 */

export type Principal = {
  readonly id: string;
  readonly authenticated: boolean;
  readonly org_id: string;
  readonly role?: string;
  readonly permissions: readonly string[];
  readonly attributes: Readonly<Record<string, unknown>>;
};

/**
 * Resolves `${principal.*}` references.
 *
 * This is what makes `resource: { org_id: "${principal.org_id}" }` a real
 * cross-tenant control rather than a comment: the value is taken from the
 * verified principal, never from the model's arguments (threat-model §T8 —
 * the model is never asked to supply an org id or a user id).
 *
 * An unresolvable reference yields a sentinel that matches nothing, so a typo
 * in a policy fails closed rather than comparing against the literal string.
 */
const UNRESOLVABLE = Symbol("unresolvable-interpolation");

export function interpolate(value: unknown, principal: Principal): unknown {
  if (typeof value !== "string") return value;

  const whole = /^\$\{principal\.([a-zA-Z0-9_.]+)\}$/.exec(value);
  if (whole === null) return value;

  const path = whole[1];
  if (path === undefined) return UNRESOLVABLE;

  switch (path) {
    case "id":
      return principal.id;
    case "org_id":
      return principal.org_id;
    case "role":
      return principal.role ?? UNRESOLVABLE;
    default:
      break;
  }

  if (path.startsWith("attributes.")) {
    const key = path.slice("attributes.".length);
    return key in principal.attributes ? principal.attributes[key] : UNRESOLVABLE;
  }

  return UNRESOLVABLE;
}

/** Reads a dotted path out of a value. Returns undefined rather than throwing. */
export function readPath(source: unknown, path: string): unknown {
  let current: unknown = source;

  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;

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

function isComparison(matcher: unknown): matcher is Comparison {
  if (typeof matcher !== "object" || matcher === null || Array.isArray(matcher)) return false;
  const keys = Object.keys(matcher);
  return (
    keys.length > 0 &&
    keys.every((key) =>
      ["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains", "exists"].includes(key),
    )
  );
}

/** Structural equality for the JSON-shaped values a policy can compare. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }

  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    return (
      ka.length === kb.length &&
      ka.every((key, i) => key === kb[i]) &&
      ka.every((key) =>
        deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
      )
    );
  }

  return false;
}

function compare(actual: unknown, comparison: Comparison, principal: Principal): boolean {
  for (const [operator, rawOperand] of Object.entries(comparison)) {
    const operand = interpolate(rawOperand, principal);
    if (operand === UNRESOLVABLE) return false;

    switch (operator) {
      case "exists":
        if ((actual !== undefined && actual !== null) !== operand) return false;
        break;

      case "eq":
        if (!deepEqual(actual, operand)) return false;
        break;

      case "ne":
        if (deepEqual(actual, operand)) return false;
        break;

      // Numeric comparisons are numeric only. Coercing "10" to 10 here would
      // mean a string argument could satisfy an amount threshold, which is
      // exactly the argument-manipulation path §T8 is about.
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        if (typeof actual !== "number" || typeof operand !== "number") return false;
        const ok =
          operator === "gt"
            ? actual > operand
            : operator === "gte"
              ? actual >= operand
              : operator === "lt"
                ? actual < operand
                : actual <= operand;
        if (!ok) return false;
        break;
      }

      case "in":
        if (!Array.isArray(operand)) return false;
        if (!operand.some((candidate) => deepEqual(actual, candidate))) return false;
        break;

      /** Subset semantics: the actual collection must contain the operand. */
      case "contains":
        if (Array.isArray(actual)) {
          if (!actual.some((item) => deepEqual(item, operand))) return false;
        } else if (typeof actual === "string" && typeof operand === "string") {
          if (!actual.includes(operand)) return false;
        } else {
          return false;
        }
        break;

      default:
        // An operator the schema permitted but this function does not implement
        // must not silently pass. Fail closed.
        return false;
    }
  }

  return true;
}

/**
 * Matches one value against one matcher.
 *
 * A bare literal is an exact match; an array literal means "one of"; an object
 * is a comparison.
 */
export function matches(actual: unknown, matcher: unknown, principal: Principal): boolean {
  if (isComparison(matcher)) return compare(actual, matcher, principal);

  const expected = interpolate(matcher, principal);
  if (expected === UNRESOLVABLE) return false;

  if (Array.isArray(expected)) {
    return expected.some((candidate) => deepEqual(actual, interpolate(candidate, principal)));
  }

  return deepEqual(actual, expected);
}

/** Every path in `spec` must match the corresponding value in `subject`. */
export function matchesAll(
  subject: unknown,
  spec: Readonly<Record<string, unknown>>,
  principal: Principal,
): boolean {
  return Object.entries(spec).every(([path, matcher]) =>
    matches(readPath(subject, path), matcher, principal),
  );
}
