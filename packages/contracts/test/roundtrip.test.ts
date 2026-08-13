import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { platformEventSchema } from "../src/events.js";
import { toInputJsonSchema, toJsonSchema } from "../src/json-schema.js";
import { toolContractSchema } from "../src/tool.js";
import { CONTRACT_FIXTURES, validContract } from "./fixtures.js";

/**
 * The round-trip proof: Zod → JSON Schema → validation must agree with Zod.
 *
 * Ajv is deliberately a *different* implementation. Validating the emitted
 * schema with Zod again would only prove Zod agrees with itself, which is not
 * the property that matters — the property that matters is that a model
 * provider or an SDK consuming our emitted JSON Schema reaches the same verdict
 * we do.
 */
const ajv = new Ajv2020({ strict: false, allErrors: true });

describe("Zod → JSON Schema round trip", () => {
  const inputSchema = toInputJsonSchema(toolContractSchema, { name: "ToolContract" });
  const validate = ajv.compile(inputSchema);

  it("emits a compilable draft 2020-12 schema", () => {
    expect(inputSchema.$schema).toContain("2020-12");
    expect(typeof validate).toBe("function");
  });

  it.each(CONTRACT_FIXTURES.map((c) => [c.name, c] as const))(
    "agrees with Zod on the valid fixture %s",
    (_name, contract) => {
      const zodVerdict = toolContractSchema.safeParse(contract).success;
      const ajvVerdict = validate(contract);

      expect(zodVerdict).toBe(true);
      expect(ajvVerdict).toBe(zodVerdict);
    },
  );

  const INVALID: readonly (readonly [string, unknown])[] = [
    [
      "missing timeout_ms",
      (() => {
        const { timeout_ms: _o, ...rest } = validContract();
        return rest;
      })(),
    ],
    ["timeout_ms of zero", validContract({ timeout_ms: 0 })],
    ["timeout_ms above the cap", validContract({ timeout_ms: 600_001 })],
    ["non-snake_case name", validContract({ name: "GetCustomer" })],
    ["empty name", validContract({ name: "" })],
    ["version below one", validContract({ version: 0 })],
    ["unknown target", validContract({ target: "carrier_pigeon" as never })],
    ["unknown side_effect", validContract({ side_effect: "mutate" as never })],
    ["unknown risk", validContract({ risk: "extreme" as never })],
    ["service auth without secret_ref", validContract({ auth: { kind: "service" } as never })],
    ["unknown auth kind", validContract({ auth: { kind: "magic" } as never })],
    [
      "user_oauth without scopes",
      validContract({
        auth: { kind: "user_oauth", provider: "salesforce" } as never,
      }),
    ],
    [
      "negative retry max",
      validContract({
        retry: { max: -1, backoff: "none", on: [] },
      }),
    ],
    [
      "unknown backoff",
      validContract({
        retry: { max: 1, backoff: "linear" as never, on: [] },
      }),
    ],
    [
      "unknown error class in retry.on",
      validContract({
        retry: { max: 1, backoff: "none", on: ["SomethingElse" as never] },
      }),
    ],
    [
      "missing description",
      (() => {
        const { description: _o, ...rest } = validContract();
        return rest;
      })(),
    ],
    ["negative cache ttl", validContract({ cache: { ttl_s: -1, key_from: ["q"] } })],
    ["concurrency max below one", validContract({ concurrency: { max: 0 } })],
  ];

  it.each(INVALID)("agrees with Zod rejecting: %s", (_label, contract) => {
    const zodVerdict = toolContractSchema.safeParse(contract).success;
    const ajvVerdict = validate(contract);

    expect(zodVerdict).toBe(false);
    expect(ajvVerdict).toBe(zodVerdict);
  });
});

describe("output-side emission", () => {
  it("marks defaulted fields required, because Zod always produces them", () => {
    const outputSchema = toJsonSchema(toolContractSchema) as {
      required?: string[];
    };
    const inputSchema = toInputJsonSchema(toolContractSchema) as { required?: string[] };

    expect(outputSchema.required).toContain("accepts_untrusted_args");
    expect(inputSchema.required ?? []).not.toContain("accepts_untrusted_args");
  });

  it("validates a parsed contract against the output schema", () => {
    const parsed = toolContractSchema.parse(validContract());
    const validateOutput = ajv.compile(toJsonSchema(toolContractSchema));

    expect(validateOutput(parsed)).toBe(true);
  });
});

describe("platform event schema emission", () => {
  it("compiles and agrees with Zod on a valid event", () => {
    const validateEvent = ajv.compile(toInputJsonSchema(platformEventSchema));
    const event = {
      id: "evt_1",
      type: "run.started",
      project_id: "proj_1",
      created_at: "2026-08-13T10:00:00Z",
      data: { agent_version_id: "av_1", trigger: "chat", simulated: false },
    };

    expect(platformEventSchema.safeParse(event).success).toBe(true);
    expect(validateEvent(event)).toBe(true);
  });

  it("agrees with Zod rejecting an unknown event type", () => {
    const validateEvent = ajv.compile(toInputJsonSchema(platformEventSchema));
    const event = {
      id: "evt_1",
      type: "run.exploded",
      project_id: "proj_1",
      created_at: "2026-08-13T10:00:00Z",
      data: {},
    };

    expect(platformEventSchema.safeParse(event).success).toBe(false);
    expect(validateEvent(event)).toBe(false);
  });
});
