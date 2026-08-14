import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parsePolicyDocument } from "../src/document.js";
import { BUILTIN_RULES, evaluate, explain } from "../src/evaluate.js";

/**
 * The evaluator is total: across generated inputs it never throws and always
 * returns a decision.
 *
 * This matters more than it might look. The evaluator sits on the authorization
 * path, and an exception there is not a neutral failure — depending on how the
 * caller handles it, a throw can become an accidental allow. "Never throws" is
 * therefore a security property, not a robustness nicety, and a property test is
 * the only honest way to assert it: a table can only cover the inputs someone
 * thought of, and the inputs nobody thought of are the ones that matter.
 */

const jsonValue = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small" },
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.double({ noNaN: true }),
    fc.string(),
    fc.array(tie("value"), { maxLength: 4 }),
    fc.dictionary(fc.string(), tie("value"), { maxKeys: 4 }),
  ),
})).value;

const comparison = fc.oneof(
  fc.record({ eq: jsonValue }),
  fc.record({ ne: jsonValue }),
  fc.record({ gt: fc.integer() }),
  fc.record({ gte: fc.integer() }),
  fc.record({ lt: fc.integer() }),
  fc.record({ lte: fc.integer() }),
  fc.record({ in: fc.array(jsonValue, { maxLength: 4 }) }),
  fc.record({ contains: fc.oneof(fc.string(), fc.integer(), fc.boolean()) }),
  fc.record({ exists: fc.boolean() }),
);

const matcher = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.oneof(fc.string(), fc.integer(), fc.boolean()), { maxLength: 3 }),
  comparison,
  // Interpolation, including references that cannot resolve.
  fc.constantFrom(
    "${principal.org_id}",
    "${principal.id}",
    "${principal.role}",
    "${principal.attributes.team}",
    "${principal.nonsense}",
    "${principal.}",
  ),
);

const ruleId = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/).filter((s) => s.length > 0);

const rule = fc.record(
  {
    id: ruleId,
    match: fc.record(
      {
        tool: fc.option(
          fc.oneof(
            fc.string(),
            fc.array(fc.string(), { maxLength: 3 }),
            fc.record(
              {
                name: fc.option(fc.string(), { nil: undefined }),
                risk: fc.option(fc.constantFrom("read", "low", "high", "critical"), {
                  nil: undefined,
                }),
                side_effect: fc.option(fc.constantFrom("read", "write", "destructive"), {
                  nil: undefined,
                }),
              },
              { requiredKeys: [] },
            ),
          ),
          { nil: undefined },
        ),
        args: fc.option(fc.dictionary(fc.string(), matcher, { maxKeys: 3 }), { nil: undefined }),
      },
      { requiredKeys: [] },
    ),
    when: fc.option(
      fc.record(
        {
          principal: fc.option(
            fc.record(
              {
                authenticated: fc.option(fc.boolean(), { nil: undefined }),
                org_id: fc.option(matcher, { nil: undefined }),
                permissions: fc.option(comparison, { nil: undefined }),
              },
              { requiredKeys: [] },
            ),
            { nil: undefined },
          ),
          resource: fc.option(fc.dictionary(fc.string(), matcher, { maxKeys: 3 }), {
            nil: undefined,
          }),
          args: fc.option(
            fc.record({
              integrity: fc.constantFrom("system", "developer", "user", "tool", "external"),
            }),
            { nil: undefined },
          ),
        },
        { requiredKeys: [] },
      ),
      { nil: undefined },
    ),
    effect: fc.constantFrom("allow", "deny"),
    approval: fc.option(fc.record({ mode: fc.constantFrom("confirm", "approve") }), {
      nil: undefined,
    }),
  },
  { requiredKeys: ["id", "match", "effect"] },
);

const evaluationInput = fc.record({
  principal: fc.record({
    id: fc.string(),
    authenticated: fc.boolean(),
    org_id: fc.string(),
    role: fc.option(fc.string(), { nil: undefined }),
    permissions: fc.array(fc.string(), { maxLength: 5 }),
    attributes: fc.dictionary(fc.string(), jsonValue, { maxKeys: 3 }),
  }),
  tool: fc.record({
    name: fc.string(),
    risk: fc.constantFrom("read", "low", "high", "critical"),
    side_effect: fc.constantFrom("read", "write", "destructive"),
    target: fc.constantFrom("openapi", "mcp", "client", "server"),
    accepts_untrusted_args: fc.option(fc.boolean(), { nil: undefined }),
    egress: fc.option(fc.array(fc.string(), { maxLength: 3 }), { nil: undefined }),
  }),
  args: fc.dictionary(fc.string(), jsonValue, { maxKeys: 5 }),
  args_integrity: fc.constantFrom("system", "developer", "user", "tool", "external"),
  resource: fc.option(fc.dictionary(fc.string(), jsonValue, { maxKeys: 3 }), { nil: undefined }),
  environment: fc.constantFrom("development", "staging", "production"),
  human_approved: fc.option(fc.boolean(), { nil: undefined }),
  destination: fc.option(fc.string(), { nil: undefined }),
});

const EFFECTS = ["allow", "deny", "require_approval"];

describe("the evaluator is total", () => {
  it("always returns a decision and never throws", () => {
    fc.assert(
      fc.property(fc.array(rule, { maxLength: 6 }), evaluationInput, (rules, input) => {
        const parsed = parsePolicyDocument({ version: 1, rules });
        // Generated rules can collide on id; those documents are rejected by
        // the parser, which is itself the correct behaviour. Only evaluate
        // documents the parser accepted.
        if (!parsed.ok) return true;

        const decision = evaluate(parsed.document, input as never);

        expect(EFFECTS).toContain(decision.effect);
        expect(typeof decision.rule_id).toBe("string");
        expect(decision.rule_id.length).toBeGreaterThan(0);
        expect(typeof decision.reason).toBe("string");
        return true;
      }),
      { numRuns: 500 },
    );
  });

  it("is deterministic — the same inputs always give the same decision", () => {
    fc.assert(
      fc.property(fc.array(rule, { maxLength: 5 }), evaluationInput, (rules, input) => {
        const parsed = parsePolicyDocument({ version: 1, rules });
        if (!parsed.ok) return true;

        const first = evaluate(parsed.document, input as never);
        const second = evaluate(parsed.document, input as never);

        expect(first).toEqual(second);
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it("explain never throws either, and always accounts for every rule", () => {
    fc.assert(
      fc.property(fc.array(rule, { maxLength: 5 }), evaluationInput, (rules, input) => {
        const parsed = parsePolicyDocument({ version: 1, rules });
        if (!parsed.ok) return true;

        const { decision, considered } = explain(parsed.document, input as never);

        expect(EFFECTS).toContain(decision.effect);
        expect(considered.length).toBeGreaterThan(0);
        // Evaluation stops at the first match, so this is an upper bound.
        expect(considered.length).toBeLessThanOrEqual(2 + parsed.document.rules.length);

        // The stronger property, and the one that actually matters: the trace
        // agrees with the decision. Either exactly the last entry matched and
        // it is the rule that decided, or nothing matched and the decision is
        // the default deny. An explanation that disagrees with the decision
        // would be worse than no explanation.
        const matched = considered.filter((t) => t.matched);
        if (decision.rule_id === BUILTIN_RULES.defaultDeny) {
          expect(matched).toHaveLength(0);
        } else {
          expect(matched).toHaveLength(1);
          expect(considered.at(-1)?.rule_id).toBe(decision.rule_id);
        }

        // Every rule that did not match must say why.
        for (const trace of considered.filter((t) => !t.matched)) {
          expect(trace.reason).not.toBe("");
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it("never allows a mutation on externally derived arguments without an exemption", () => {
    // The security property I1 exists for, asserted across generated policies
    // rather than only the ones I thought to write.
    fc.assert(
      fc.property(fc.array(rule, { maxLength: 6 }), evaluationInput, (rules, raw) => {
        const parsed = parsePolicyDocument({ version: 1, rules });
        if (!parsed.ok) return true;

        const input = {
          ...raw,
          args_integrity: "external" as const,
          human_approved: false,
          tool: { ...raw.tool, side_effect: "destructive" as const, accepts_untrusted_args: false },
        };

        const decision = evaluate(parsed.document, input as never);

        expect(decision.effect).toBe("deny");
        expect(decision.rule_id).toBe(BUILTIN_RULES.i1);
        return true;
      }),
      { numRuns: 300 },
    );
  });
});
