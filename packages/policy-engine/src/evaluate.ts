import type { PolicyDocument, Rule } from "./document.js";
import { matches, matchesAll, type Principal } from "./match.js";

/**
 * The evaluator (doc 03 §C2).
 *
 * Deterministic and total: same inputs, same decision, always; and no input
 * makes it throw. There is no model in this path and never will be — a
 * probabilistic authorization decision is not an authorization decision.
 *
 * Default-deny. A request that matches nothing is denied, and the denial says
 * so rather than pretending a rule was involved.
 */

export type ToolFacts = {
  readonly name: string;
  readonly risk: string;
  readonly side_effect: "read" | "write" | "destructive";
  readonly target: string;
  /** Doc 02 §1: the tool has opted into accepting untrusted arguments. */
  readonly accepts_untrusted_args?: boolean;
  /** Allowlisted egress destinations, for invariant I2. */
  readonly egress?: readonly string[];
};

export type EvaluationInput = {
  readonly principal: Principal;
  readonly tool: ToolFacts;
  readonly args: Readonly<Record<string, unknown>>;
  /** The taint of the arguments, from the runtime's label propagation. */
  readonly args_integrity: "system" | "developer" | "user" | "tool" | "external";
  readonly resource?: Readonly<Record<string, unknown>>;
  readonly environment: string;
  /** Set once a human has approved this specific call — the I1 escape hatch. */
  readonly human_approved?: boolean;
  /** Where the call would send data, for I2. */
  readonly destination?: string;
};

export type Decision = {
  readonly effect: "allow" | "deny" | "require_approval";
  readonly rule_id: string;
  readonly reason: string;
  readonly approval?: { readonly mode: "confirm" | "approve"; readonly by_role?: string };
};

export type RuleTrace = {
  readonly rule_id: string;
  readonly matched: boolean;
  /** Why it did not match. Empty when it did. */
  readonly reason: string;
};

export type Explanation = {
  readonly decision: Decision;
  readonly considered: readonly RuleTrace[];
};

/**
 * Built-in rule ids. These are not in the document and cannot be edited or
 * removed by a policy author — the taint invariants are architectural
 * guarantees (doc 01 §4.4), not preferences.
 */
export const BUILTIN_RULES = {
  i1: "builtin-i1-untrusted-arguments",
  i2: "builtin-i2-egress-confinement",
  defaultDeny: "default-deny",
} as const;

/**
 * I1 — control-flow integrity.
 *
 * Arguments to a mutating tool may not derive from external data unless the
 * tool declared `accepts_untrusted_args` or a human approved this call.
 *
 * Evaluated *before* the document, so no allow rule can override it. A policy
 * author who could write a rule that permits acting on injected instructions
 * would be able to disable the mitigation by accident.
 */
function checkI1(input: EvaluationInput): Decision | undefined {
  if (input.tool.side_effect === "read") return undefined;
  if (input.args_integrity !== "external") return undefined;
  if (input.tool.accepts_untrusted_args === true) return undefined;
  if (input.human_approved === true) return undefined;

  return {
    effect: "deny",
    rule_id: BUILTIN_RULES.i1,
    reason: "Refusing to act on instructions found in retrieved content.",
  };
}

/**
 * I2 — data-flow confinement.
 *
 * A call carrying data that came from somewhere may not send it to a
 * destination the tool has not allowlisted. An absent allowlist denies, which
 * is the default-deny posture: a tool that has not said where it may send data
 * may not send it anywhere.
 */
function checkI2(input: EvaluationInput): Decision | undefined {
  if (input.destination === undefined) return undefined;
  if (input.args_integrity === "system" || input.args_integrity === "developer") return undefined;

  const allowlist = input.tool.egress ?? [];
  if (allowlist.includes(input.destination)) return undefined;

  return {
    effect: "deny",
    rule_id: BUILTIN_RULES.i2,
    reason: `Refusing to send data to "${input.destination}", which is not an allowlisted destination for this tool.`,
  };
}

function toolMatches(rule: Rule, input: EvaluationInput): boolean {
  const spec = rule.match.tool;
  if (spec === undefined) return true;

  if (typeof spec === "string") return spec === input.tool.name;
  if (Array.isArray(spec)) return spec.includes(input.tool.name);

  const oneOf = (value: string | readonly string[] | undefined, actual: string): boolean =>
    value === undefined ? true : Array.isArray(value) ? value.includes(actual) : value === actual;

  return (
    oneOf(spec.name, input.tool.name) &&
    oneOf(spec.risk, input.tool.risk) &&
    oneOf(spec.side_effect, input.tool.side_effect) &&
    oneOf(spec.target, input.tool.target)
  );
}

/** Returns the reason a rule did not match, or undefined when it did. */
function whyNotMatched(rule: Rule, input: EvaluationInput): string | undefined {
  if (!toolMatches(rule, input)) return "tool does not match";

  if (rule.match.args !== undefined && !matchesAll(input.args, rule.match.args, input.principal)) {
    return "arguments do not match";
  }

  const when = rule.when;
  if (when === undefined) return undefined;

  if (when.environment !== undefined) {
    const ok = Array.isArray(when.environment)
      ? when.environment.includes(input.environment)
      : when.environment === input.environment;
    if (!ok) return `environment is ${input.environment}`;
  }

  const p = when.principal;
  if (p !== undefined) {
    if (p.authenticated !== undefined && p.authenticated !== input.principal.authenticated) {
      return "principal authentication does not match";
    }
    if (p.id !== undefined && !matches(input.principal.id, p.id, input.principal)) {
      return "principal id does not match";
    }
    if (p.role !== undefined && !matches(input.principal.role, p.role, input.principal)) {
      return "principal role does not match";
    }
    if (p.org_id !== undefined && !matches(input.principal.org_id, p.org_id, input.principal)) {
      return "principal org does not match";
    }
    if (
      p.permissions !== undefined &&
      !matches(input.principal.permissions, p.permissions, input.principal)
    ) {
      return "principal lacks the required permission";
    }
    if (
      p.attributes !== undefined &&
      !matchesAll(input.principal.attributes, p.attributes, input.principal)
    ) {
      return "principal attributes do not match";
    }
  }

  if (when.resource !== undefined) {
    if (!matchesAll(input.resource ?? {}, when.resource, input.principal)) {
      return "resource does not match";
    }
  }

  if (when.args?.integrity !== undefined) {
    const ok = Array.isArray(when.args.integrity)
      ? when.args.integrity.includes(input.args_integrity)
      : when.args.integrity === input.args_integrity;
    if (!ok) return `argument integrity is ${input.args_integrity}`;
  }

  return undefined;
}

function decisionFor(rule: Rule): Decision {
  if (rule.effect === "deny") {
    return {
      effect: "deny",
      rule_id: rule.id,
      reason: rule.message ?? "This action is not permitted.",
    };
  }

  if (rule.approval !== undefined) {
    return {
      effect: "require_approval",
      rule_id: rule.id,
      reason: rule.message ?? "This action needs approval before it can run.",
      approval: {
        mode: rule.approval.mode,
        ...(rule.approval.by === undefined ? {} : { by_role: rule.approval.by.role }),
      },
    };
  }

  return { effect: "allow", rule_id: rule.id, reason: "Permitted by policy." };
}

/**
 * Evaluate one call.
 *
 * Precedence, in order:
 *   1. Built-in taint invariants — not overridable by any document rule.
 *   2. The first matching document rule, in file order. First match wins, and
 *      the document is read top to bottom, so precedence is visible on the page
 *      rather than being a property of a sorting function nobody reads.
 *   3. Default deny.
 *
 * Never throws. A malformed rule that cannot be evaluated simply does not
 * match, which fails closed.
 */
export function evaluate(document: PolicyDocument, input: EvaluationInput): Decision {
  return explain(document, input).decision;
}

/**
 * The same evaluation, plus why each rule did or did not match.
 *
 * This is what `keel policy explain` prints and what makes "why was this
 * denied?" a lookup rather than an investigation (doc 03 §C2).
 */
export function explain(document: PolicyDocument, input: EvaluationInput): Explanation {
  const considered: RuleTrace[] = [];

  const i1 = checkI1(input);
  if (i1 !== undefined) {
    considered.push({ rule_id: BUILTIN_RULES.i1, matched: true, reason: "" });
    return { decision: i1, considered };
  }
  considered.push({
    rule_id: BUILTIN_RULES.i1,
    matched: false,
    reason: "arguments are not externally derived, or the call is exempt",
  });

  const i2 = checkI2(input);
  if (i2 !== undefined) {
    considered.push({ rule_id: BUILTIN_RULES.i2, matched: true, reason: "" });
    return { decision: i2, considered };
  }
  considered.push({
    rule_id: BUILTIN_RULES.i2,
    matched: false,
    reason: "no egress, or the destination is allowlisted",
  });

  for (const rule of document.rules) {
    let why: string | undefined;
    try {
      why = whyNotMatched(rule, input);
    } catch {
      // A rule that cannot be evaluated does not match. It must never abort the
      // evaluation, because an exception on the authorization path can become
      // an accidental allow depending on how the caller handles it.
      why = "rule could not be evaluated";
    }

    if (why === undefined) {
      considered.push({ rule_id: rule.id, matched: true, reason: "" });
      return { decision: decisionFor(rule), considered };
    }

    considered.push({ rule_id: rule.id, matched: false, reason: why });
  }

  return {
    decision: {
      effect: "deny",
      rule_id: BUILTIN_RULES.defaultDeny,
      reason: "No policy rule permits this action.",
    },
    considered,
  };
}

/**
 * Catalogue filtering (doc 03 §C3).
 *
 * A tool the principal may not use is never offered, so the model cannot
 * promise it. Filtering happens before anything about the tool's existence
 * reaches the model.
 *
 * A tool whose decision is `require_approval` stays in the catalogue: the user
 * may still ask for it, they will simply be asked to confirm.
 */
export function filterCatalogue(
  document: PolicyDocument,
  tools: readonly ToolFacts[],
  context: {
    readonly principal: Principal;
    readonly environment: string;
    readonly args_integrity?: EvaluationInput["args_integrity"];
  },
): readonly ToolFacts[] {
  return tools.filter((tool) => {
    const decision = evaluate(document, {
      principal: context.principal,
      tool,
      // No arguments are known at catalogue time, so a rule that narrows by
      // argument value cannot be satisfied here. That means a tool gated only
      // on an argument condition is offered and then denied at call time —
      // which is correct: hiding it would make the assistant unable to explain
      // why it cannot help.
      args: {},
      args_integrity: context.args_integrity ?? "user",
      environment: context.environment,
    });

    return decision.effect !== "deny";
  });
}
