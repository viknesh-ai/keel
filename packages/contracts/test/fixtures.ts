import type { ToolContractInput } from "../src/tool.js";

/** A schema with a closed argument domain, as every contract must have. */
export const closedSchema: Record<string, unknown> = {
  type: "object",
  properties: { customer_id: { type: "string" } },
  required: ["customer_id"],
  additionalProperties: false,
};

export const outputSchema: Record<string, unknown> = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

export function validContract(overrides: Partial<ToolContractInput> = {}): ToolContractInput {
  return {
    name: "get_customer",
    version: 1,
    title: "Get customer",
    description: "A single customer: plan, billing status, activity.",
    input: closedSchema,
    output: outputSchema,
    target: "openapi",
    side_effect: "read",
    risk: "read",
    auth: { kind: "service", secret_ref: "secret://northwind/api" },
    timeout_ms: 5_000,
    retry: { max: 2, backoff: "exponential", on: ["ToolExecutionError", "ToolTimeoutError"] },
    idempotency: { required: false },
    ...overrides,
  };
}

/** Every contract shape the round-trip test must agree on. */
export const CONTRACT_FIXTURES: readonly ToolContractInput[] = [
  validContract(),
  validContract({
    name: "upgrade_subscription",
    side_effect: "write",
    risk: "high",
    auth: { kind: "user_action_token" },
    idempotency: { required: true, key_from: ["customer_id"] },
  }),
  validContract({
    name: "cancel_subscription",
    side_effect: "destructive",
    risk: "critical",
    auth: { kind: "user_action_token" },
    idempotency: { required: true, key_from: ["customer_id", "reason"] },
    retry: { max: 0, backoff: "none", on: [] },
    egress: ["api.northwind.example"],
  }),
  validContract({
    name: "open_customer_profile",
    target: "navigation",
    side_effect: "read",
    risk: "read",
    auth: { kind: "none" },
    timeout_ms: 1_000,
    renderer: "customer_card",
  }),
  validContract({
    name: "search_docs",
    target: "knowledge",
    auth: { kind: "none" },
    cache: { ttl_s: 300, key_from: ["query"] },
    examples: [{ input: { query: "refunds" }, output: { ok: true }, note: "typical" }],
  }),
  validContract({
    name: "sync_crm_contact",
    target: "mcp",
    side_effect: "write",
    risk: "high",
    auth: { kind: "user_oauth", provider: "salesforce", scopes: ["contacts.write"] },
    idempotency: { required: true, key_from: ["contact_id"] },
    accepts_untrusted_args: true,
    egress: ["crm.example.com"],
    concurrency: { group: "crm", max: 2 },
  }),
];
