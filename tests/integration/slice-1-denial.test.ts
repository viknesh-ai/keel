import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluate,
  filterCatalogue,
  type Principal,
  parsePolicyDocument,
  type ToolFacts,
} from "@keel/policy-engine";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The slice 1 denial test.
 *
 * The exit criterion has two halves, and the second is the one that matters:
 * a principal without `customers.read` is denied, **and the tool is not even
 * present in the catalogue sent to the model.**
 *
 * Enforcing only the first half would leave the model able to promise something
 * it cannot do, and would leak the existence of a capability the user has no
 * business knowing about (doc 03 §C3).
 *
 * Runs against the real committed artifacts — the generated tool contracts, the
 * enablement list and the policy document — not against fixtures written to
 * agree with the assertions.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const demo = join(root, "apps", "demo-saas", "keel");

const generated = parse(readFileSync(join(demo, "tools", "northwind.yaml"), "utf8")) as {
  tools: { operationId: string; risk: string; side_effect: string; enabled: boolean }[];
};

const enablement = parse(readFileSync(join(demo, "tools", "enabled.yaml"), "utf8")) as {
  enabled: string[];
};

const policyFile = parse(readFileSync(join(demo, "policy", "production.yaml"), "utf8")) as unknown;
const parsedPolicy = parsePolicyDocument(policyFile);
if (!parsedPolicy.ok) throw new Error(JSON.stringify(parsedPolicy.issues));
const policy = parsedPolicy.document;

/** The catalogue the runtime would assemble: generated contracts, enabled subset. */
const catalogue: readonly ToolFacts[] = generated.tools
  .filter((tool) => enablement.enabled.includes(tool.operationId))
  .map((tool) => ({
    name: tool.operationId,
    risk: tool.risk,
    side_effect: tool.side_effect as ToolFacts["side_effect"],
    target: "openapi",
  }));

const principal = (permissions: readonly string[], over: Partial<Principal> = {}): Principal => ({
  id: "stf_1",
  authenticated: true,
  org_id: "org_northwind",
  role: "support",
  permissions,
  attributes: {},
  ...over,
});

describe("the committed artifacts are consistent", () => {
  it("enables exactly three operations, all reads", () => {
    expect(enablement.enabled).toHaveLength(3);
    expect(catalogue.every((tool) => tool.side_effect === "read")).toBe(true);
  });

  it("names only operations that actually exist in the generated contracts", () => {
    // A typo here would silently enable nothing, and the slice would fail for a
    // reason nobody could see.
    const known = new Set(generated.tools.map((t) => t.operationId));
    for (const name of enablement.enabled) expect(known.has(name)).toBe(true);
  });

  it("leaves the generated file entirely disabled", () => {
    // Enablement lives in its own reviewable file; the generated artifact stays
    // a faithful projection of the spec.
    expect(generated.tools.every((tool) => tool.enabled === false)).toBe(true);
  });
});

describe("a principal with customers.read", () => {
  const staff = principal(["customers.read"]);

  it("is offered the three read tools", () => {
    const offered = filterCatalogue(policy, catalogue, {
      principal: staff,
      environment: "production",
    });

    expect(offered.map((t) => t.name).sort()).toEqual([
      "getCustomer",
      "listCustomers",
      "listInvoices",
    ]);
  });

  it("is allowed to call one, and the decision names the rule", () => {
    const decision = evaluate(policy, {
      principal: staff,
      tool: catalogue.find((t) => t.name === "listCustomers") as ToolFacts,
      args: { inactive_days: 30 },
      args_integrity: "user",
      environment: "production",
    });

    expect(decision.effect).toBe("allow");
    expect(decision.rule_id).toBe("reads-for-support");
  });
});

describe("a principal WITHOUT customers.read", () => {
  const stranger = principal(["invoices.read"]);

  it("is denied when the call is attempted", () => {
    const decision = evaluate(policy, {
      principal: stranger,
      tool: catalogue.find((t) => t.name === "listCustomers") as ToolFacts,
      args: { inactive_days: 30 },
      args_integrity: "user",
      environment: "production",
    });

    expect(decision.effect).toBe("deny");
  });

  it("is not offered the tool at all — it never reaches the model's catalogue", () => {
    // The half that matters. A tool the user may not use is never offered, so
    // the model cannot promise it and its existence is not disclosed.
    const offered = filterCatalogue(policy, catalogue, {
      principal: stranger,
      environment: "production",
    });

    expect(offered).toEqual([]);
    expect(offered.map((t) => t.name)).not.toContain("listCustomers");
  });
});

describe("an unauthenticated principal", () => {
  it("is offered nothing", () => {
    const offered = filterCatalogue(policy, catalogue, {
      principal: principal(["customers.read"], { authenticated: false }),
      environment: "production",
    });

    expect(offered).toEqual([]);
  });
});

describe("mutations are refused in this slice", () => {
  it("denies a write even for a principal holding customers.read", () => {
    const decision = evaluate(policy, {
      principal: principal(["customers.read", "subscriptions.write"]),
      tool: {
        name: "cancelSubscription",
        risk: "critical",
        side_effect: "destructive",
        target: "openapi",
      },
      args: {},
      args_integrity: "user",
      environment: "production",
    });

    expect(decision.effect).toBe("deny");
    expect(decision.rule_id).toBe("no-mutations-in-slice-one");
  });

  it("is not in the catalogue either, because it was never enabled", () => {
    expect(catalogue.map((t) => t.name)).not.toContain("cancelSubscription");
  });
});
