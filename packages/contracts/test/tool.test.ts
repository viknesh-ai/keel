import { describe, expect, it } from "vitest";
import { defaultApprovalMode, validateToolContract } from "../src/tool.js";
import { closedSchema, validContract } from "./fixtures.js";

const codesOf = (result: ReturnType<typeof validateToolContract>): string[] =>
  result.ok ? [] : result.issues.map((issue) => issue.code);

describe("validateToolContract — accepts", () => {
  it("a well-formed read tool", () => {
    const result = validateToolContract(validContract());

    expect(result.ok).toBe(true);
  });

  it("and applies documented defaults", () => {
    const result = validateToolContract(validContract());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contract.accepts_untrusted_args).toBe(false);
  });

  it("defaults cache.vary_by_identity to true", () => {
    const result = validateToolContract(
      validContract({ cache: { ttl_s: 60, key_from: ["customer_id"] } }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contract.cache?.vary_by_identity).toBe(true);
  });

  it("allows opting out of vary_by_identity explicitly", () => {
    const result = validateToolContract(
      validContract({ cache: { ttl_s: 60, key_from: ["q"], vary_by_identity: false } }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contract.cache?.vary_by_identity).toBe(false);
  });
});

describe("validateToolContract — rejects", () => {
  it("a missing timeout_ms", () => {
    const { timeout_ms: _omitted, ...withoutTimeout } = validContract();

    const result = validateToolContract(withoutTimeout);

    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain("schema");
  });

  it("a timeout_ms of zero", () => {
    const result = validateToolContract(validContract({ timeout_ms: 0 }));

    expect(result.ok).toBe(false);
  });

  it("a non-snake_case name", () => {
    for (const name of ["GetCustomer", "get-customer", "1_customer", "get customer"]) {
      expect(validateToolContract(validContract({ name })).ok).toBe(false);
    }
  });

  it("a write tool without idempotency.required", () => {
    const result = validateToolContract(
      validContract({
        side_effect: "write",
        auth: { kind: "user_action_token" },
        idempotency: { required: false },
      }),
    );

    expect(codesOf(result)).toContain("idempotency_required_for_mutation");
  });

  it("a destructive tool without idempotency.required", () => {
    const result = validateToolContract(
      validContract({
        side_effect: "destructive",
        auth: { kind: "user_action_token" },
        idempotency: { required: false },
        retry: { max: 0, backoff: "none", on: [] },
      }),
    );

    expect(codesOf(result)).toContain("idempotency_required_for_mutation");
  });

  it("a mutating tool using an ambient service credential", () => {
    const result = validateToolContract(
      validContract({
        side_effect: "write",
        auth: { kind: "service", secret_ref: "secret://admin" },
        idempotency: { required: true, key_from: ["customer_id"] },
      }),
    );

    expect(codesOf(result)).toContain("ambient_write_credential");
  });

  it("unless the project explicitly allows ambient writes", () => {
    const result = validateToolContract(
      validContract({
        side_effect: "write",
        auth: { kind: "service", secret_ref: "secret://admin" },
        idempotency: { required: true, key_from: ["customer_id"] },
      }),
      { allowAmbientWrite: true },
    );

    expect(result.ok).toBe(true);
  });

  it("an input schema that leaves additionalProperties open", () => {
    const result = validateToolContract(
      validContract({ input: { ...closedSchema, additionalProperties: true } }),
    );

    expect(codesOf(result)).toContain("unsafe_additional_properties");
  });

  it("an input schema that omits additionalProperties entirely", () => {
    const result = validateToolContract(
      validContract({ input: { type: "object", properties: {} } }),
    );

    expect(codesOf(result)).toContain("unsafe_additional_properties");
  });

  it("a mutating tool that accepts untrusted args with no egress allowlist", () => {
    const result = validateToolContract(
      validContract({
        side_effect: "write",
        auth: { kind: "user_action_token" },
        idempotency: { required: true, key_from: ["customer_id"] },
        accepts_untrusted_args: true,
      }),
    );

    expect(codesOf(result)).toContain("egress_required_for_untrusted_args");
  });

  it("a retry list naming a class that is never retryable", () => {
    const result = validateToolContract(
      validContract({
        retry: { max: 2, backoff: "exponential", on: ["AuthorizationError"] },
      }),
    );

    expect(codesOf(result)).toContain("retry_on_unretryable_class");
  });

  it("a destructive tool with retries but no idempotency key", () => {
    const result = validateToolContract(
      validContract({
        side_effect: "destructive",
        auth: { kind: "user_action_token" },
        idempotency: { required: true },
        retry: { max: 3, backoff: "exponential", on: ["ToolTimeoutError"] },
      }),
    );

    expect(codesOf(result)).toContain("destructive_retry_without_key");
  });

  it("a service auth binding with no secret_ref", () => {
    const result = validateToolContract(validContract({ auth: { kind: "service" } as never }));

    expect(result.ok).toBe(false);
  });

  it("an unknown target", () => {
    const result = validateToolContract(validContract({ target: "carrier_pigeon" as never }));

    expect(result.ok).toBe(false);
  });

  it("and reports every issue at once rather than only the first", () => {
    const result = validateToolContract(
      validContract({
        side_effect: "write",
        auth: { kind: "service", secret_ref: "secret://admin" },
        idempotency: { required: false },
        input: { ...closedSchema, additionalProperties: true },
      }),
    );

    expect(codesOf(result)).toEqual(
      expect.arrayContaining([
        "idempotency_required_for_mutation",
        "ambient_write_credential",
        "unsafe_additional_properties",
      ]),
    );
  });
});

describe("defaultApprovalMode", () => {
  it("matches the risk/environment table in doc 02 §1", () => {
    expect(defaultApprovalMode("read", "production")).toBe("auto");
    expect(defaultApprovalMode("low", "production")).toBe("auto");
    expect(defaultApprovalMode("high", "development")).toBe("auto");
    expect(defaultApprovalMode("high", "staging")).toBe("confirm");
    expect(defaultApprovalMode("high", "production")).toBe("confirm");
    expect(defaultApprovalMode("critical", "development")).toBe("auto");
    expect(defaultApprovalMode("critical", "staging")).toBe("approve");
    expect(defaultApprovalMode("critical", "production")).toBe("approve");
  });
});
