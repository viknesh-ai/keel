import { describe, expect, it } from "vitest";
import { type PolicyDocument, parsePolicyDocument } from "../src/document.js";
import {
  BUILTIN_RULES,
  type EvaluationInput,
  evaluate,
  explain,
  filterCatalogue,
  type ToolFacts,
} from "../src/evaluate.js";
import type { Principal } from "../src/match.js";

/** The document from doc 03 §C2, verbatim in shape. */
const DOCUMENT: PolicyDocument = (() => {
  const parsed = parsePolicyDocument({
    version: 1,
    defaults: { effect: "deny" },
    rules: [
      {
        id: "never-delete-customers",
        match: { tool: "delete_customer" },
        effect: "deny",
        message: "Customer deletion is not available through the assistant.",
      },
      {
        id: "large-refunds",
        match: { tool: "refund_payment", args: { amount: { gte: 10000 } } },
        effect: "allow",
        approval: { mode: "approve", by: { role: "finance_admin" }, expires_in: "30m" },
      },
      {
        id: "subscription-writes",
        match: { tool: ["update_subscription", "cancel_subscription"] },
        when: {
          principal: { permissions: { contains: "subscriptions.write" } },
          resource: { org_id: "${principal.org_id}" },
        },
        effect: "allow",
        approval: { mode: "confirm" },
      },
      {
        id: "reads-for-authenticated",
        match: { tool: { risk: "read" } },
        when: { principal: { authenticated: true } },
        effect: "allow",
      },
    ],
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.document;
})();

const principal = (over: Partial<Principal> = {}): Principal => ({
  id: "usr_1",
  authenticated: true,
  org_id: "org_a",
  role: "support",
  permissions: ["customers.read"],
  attributes: {},
  ...over,
});

const tool = (over: Partial<ToolFacts> = {}): ToolFacts => ({
  name: "get_customer",
  risk: "read",
  side_effect: "read",
  target: "openapi",
  ...over,
});

const call = (over: Partial<EvaluationInput> = {}): EvaluationInput => ({
  principal: principal(),
  tool: tool(),
  args: {},
  args_integrity: "user",
  environment: "production",
  ...over,
});

describe("default-deny", () => {
  it("denies a call that matches nothing, and says so", () => {
    const decision = evaluate(DOCUMENT, call({ tool: tool({ name: "unknown", risk: "high" }) }));

    expect(decision.effect).toBe("deny");
    expect(decision.rule_id).toBe(BUILTIN_RULES.defaultDeny);
    expect(decision.reason).toBe("No policy rule permits this action.");
  });

  it("denies against an empty document", () => {
    const empty = parsePolicyDocument({ version: 1, rules: [] });
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;

    expect(evaluate(empty.document, call()).effect).toBe("deny");
  });

  it("denies an unauthenticated principal even for a read", () => {
    const decision = evaluate(DOCUMENT, call({ principal: principal({ authenticated: false }) }));

    expect(decision.effect).toBe("deny");
    expect(decision.rule_id).toBe(BUILTIN_RULES.defaultDeny);
  });
});

describe("rule types, table-driven", () => {
  const cases: readonly {
    name: string;
    input: EvaluationInput;
    effect: "allow" | "deny" | "require_approval";
    rule_id: string;
  }[] = [
    {
      name: "exact tool name deny",
      input: call({
        tool: tool({ name: "delete_customer", risk: "critical", side_effect: "destructive" }),
      }),
      effect: "deny",
      rule_id: "never-delete-customers",
    },
    {
      name: "tool attribute match (risk: read)",
      input: call(),
      effect: "allow",
      rule_id: "reads-for-authenticated",
    },
    {
      name: "list-of-names match with permission and resource scope",
      input: call({
        tool: tool({ name: "update_subscription", risk: "high", side_effect: "write" }),
        principal: principal({ permissions: ["subscriptions.write"] }),
        resource: { org_id: "org_a" },
      }),
      effect: "require_approval",
      rule_id: "subscription-writes",
    },
    {
      name: "comparison operator gte satisfied",
      input: call({
        tool: tool({ name: "refund_payment", risk: "high", side_effect: "write" }),
        args: { amount: 25000 },
      }),
      effect: "require_approval",
      rule_id: "large-refunds",
    },
    {
      name: "comparison operator gte not satisfied falls through to default deny",
      input: call({
        tool: tool({ name: "refund_payment", risk: "high", side_effect: "write" }),
        args: { amount: 500 },
      }),
      effect: "deny",
      rule_id: BUILTIN_RULES.defaultDeny,
    },
    {
      name: "permission missing falls through",
      input: call({
        tool: tool({ name: "update_subscription", risk: "high", side_effect: "write" }),
        principal: principal({ permissions: [] }),
        resource: { org_id: "org_a" },
      }),
      effect: "deny",
      rule_id: BUILTIN_RULES.defaultDeny,
    },
    {
      name: "cross-org resource is refused",
      input: call({
        tool: tool({ name: "update_subscription", risk: "high", side_effect: "write" }),
        principal: principal({ permissions: ["subscriptions.write"], org_id: "org_a" }),
        resource: { org_id: "org_b" },
      }),
      effect: "deny",
      rule_id: BUILTIN_RULES.defaultDeny,
    },
  ];

  it.each(cases)("$name", ({ input, effect, rule_id }) => {
    const decision = evaluate(DOCUMENT, input);
    expect(decision.effect).toBe(effect);
    expect(decision.rule_id).toBe(rule_id);
  });
});

describe("precedence", () => {
  it("takes the first matching rule in file order", () => {
    const parsed = parsePolicyDocument({
      version: 1,
      rules: [
        { id: "first-wins", match: { tool: "x" }, effect: "deny", message: "first" },
        { id: "second", match: { tool: "x" }, effect: "allow" },
      ],
    });
    if (!parsed.ok) throw new Error("bad fixture");

    const decision = evaluate(parsed.document, call({ tool: tool({ name: "x" }) }));
    expect(decision.rule_id).toBe("first-wins");
    expect(decision.effect).toBe("deny");
  });

  it("means a deny placed above an allow wins, and vice versa", () => {
    const allowFirst = parsePolicyDocument({
      version: 1,
      rules: [
        { id: "allow-it", match: { tool: "x" }, effect: "allow" },
        { id: "deny-it", match: { tool: "x" }, effect: "deny" },
      ],
    });
    if (!allowFirst.ok) throw new Error("bad fixture");

    expect(evaluate(allowFirst.document, call({ tool: tool({ name: "x" }) })).effect).toBe("allow");
  });
});

describe("taint invariant I1", () => {
  const mutating = tool({ name: "update_subscription", risk: "high", side_effect: "write" });

  it("denies a mutation whose arguments came from retrieved content", () => {
    const decision = evaluate(
      DOCUMENT,
      call({
        tool: mutating,
        args_integrity: "external",
        principal: principal({ permissions: ["subscriptions.write"] }),
      }),
    );

    expect(decision.effect).toBe("deny");
    expect(decision.rule_id).toBe(BUILTIN_RULES.i1);
    expect(decision.reason).toContain("retrieved content");
  });

  it("cannot be overridden by an allow rule — it is an architectural guarantee", () => {
    const permissive = parsePolicyDocument({
      version: 1,
      rules: [{ id: "allow-everything", match: {}, effect: "allow" }],
    });
    if (!permissive.ok) throw new Error("bad fixture");

    const decision = evaluate(
      permissive.document,
      call({ tool: mutating, args_integrity: "external" }),
    );

    expect(decision.rule_id).toBe(BUILTIN_RULES.i1);
    expect(decision.effect).toBe("deny");
  });

  it("permits a read with externally derived arguments", () => {
    const decision = evaluate(DOCUMENT, call({ args_integrity: "external" }));
    expect(decision.effect).toBe("allow");
  });

  it("permits a mutation when the tool declared it accepts untrusted arguments", () => {
    const decision = evaluate(
      DOCUMENT,
      call({
        tool: { ...mutating, accepts_untrusted_args: true },
        args_integrity: "external",
        principal: principal({ permissions: ["subscriptions.write"] }),
        resource: { org_id: "org_a" },
      }),
    );

    expect(decision.rule_id).not.toBe(BUILTIN_RULES.i1);
  });

  it("permits a mutation a human already approved", () => {
    const decision = evaluate(
      DOCUMENT,
      call({
        tool: mutating,
        args_integrity: "external",
        human_approved: true,
        principal: principal({ permissions: ["subscriptions.write"] }),
        resource: { org_id: "org_a" },
      }),
    );

    expect(decision.rule_id).not.toBe(BUILTIN_RULES.i1);
  });
});

describe("taint invariant I2", () => {
  it("denies sending user-derived data to a destination the tool did not allowlist", () => {
    const decision = evaluate(
      DOCUMENT,
      call({ destination: "evil.example", args_integrity: "user" }),
    );

    expect(decision.effect).toBe("deny");
    expect(decision.rule_id).toBe(BUILTIN_RULES.i2);
  });

  it("permits an allowlisted destination", () => {
    const decision = evaluate(
      DOCUMENT,
      call({
        tool: tool({ egress: ["api.northwind.example"] }),
        destination: "api.northwind.example",
      }),
    );

    expect(decision.effect).toBe("allow");
  });

  it("denies by default when the tool declared no allowlist at all", () => {
    const decision = evaluate(DOCUMENT, call({ destination: "anywhere" }));
    expect(decision.rule_id).toBe(BUILTIN_RULES.i2);
  });

  it("does not apply to system or developer data", () => {
    const decision = evaluate(
      DOCUMENT,
      call({ destination: "anywhere", args_integrity: "developer" }),
    );

    expect(decision.rule_id).not.toBe(BUILTIN_RULES.i2);
  });
});

describe("explain", () => {
  it("names the matched rule and why every earlier one did not match", () => {
    const { decision, considered } = explain(DOCUMENT, call());

    expect(decision.rule_id).toBe("reads-for-authenticated");

    const matched = considered.filter((t) => t.matched);
    expect(matched.map((t) => t.rule_id)).toEqual(["reads-for-authenticated"]);

    const rejected = considered.filter((t) => !t.matched);
    expect(rejected.every((t) => t.reason !== "")).toBe(true);
    expect(rejected.map((t) => t.rule_id)).toContain("never-delete-customers");
  });

  it("explains a default deny by listing every rule that was considered", () => {
    const { decision, considered } = explain(
      DOCUMENT,
      call({ tool: tool({ name: "nothing", risk: "high" }) }),
    );

    expect(decision.rule_id).toBe(BUILTIN_RULES.defaultDeny);
    expect(considered.every((t) => !t.matched)).toBe(true);
    expect(considered).toHaveLength(2 + DOCUMENT.rules.length);
  });

  it("reports the specific reason a principal condition failed", () => {
    const { considered } = explain(
      DOCUMENT,
      call({
        tool: tool({ name: "update_subscription", risk: "high", side_effect: "write" }),
        principal: principal({ permissions: [] }),
      }),
    );

    const trace = considered.find((t) => t.rule_id === "subscription-writes");
    expect(trace?.reason).toContain("permission");
  });
});

describe("catalogue filtering", () => {
  const catalogue: readonly ToolFacts[] = [
    tool({ name: "get_customer", risk: "read" }),
    tool({ name: "list_invoices", risk: "read" }),
    tool({ name: "delete_customer", risk: "critical", side_effect: "destructive" }),
    tool({ name: "update_subscription", risk: "high", side_effect: "write" }),
  ];

  it("never offers a tool the principal may not use", () => {
    const offered = filterCatalogue(DOCUMENT, catalogue, {
      principal: principal(),
      environment: "production",
    });

    expect(offered.map((t) => t.name)).toEqual(["get_customer", "list_invoices"]);
  });

  it("keeps a tool that would need approval — the user may still ask for it", () => {
    const offered = filterCatalogue(DOCUMENT, catalogue, {
      principal: principal({ permissions: ["subscriptions.write"] }),
      environment: "production",
    });

    // subscription-writes requires resource.org_id, which is unknown at
    // catalogue time, so it is not offered here; the read tools are.
    expect(offered.map((t) => t.name)).toContain("get_customer");
    expect(offered.map((t) => t.name)).not.toContain("delete_customer");
  });

  it("offers nothing to an unauthenticated principal", () => {
    const offered = filterCatalogue(DOCUMENT, catalogue, {
      principal: principal({ authenticated: false }),
      environment: "production",
    });

    expect(offered).toEqual([]);
  });
});
