import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { dereference } from "../src/openapi/dereference.js";
import { emitToolsYaml } from "../src/openapi/emit.js";
import { generateFromSpec } from "../src/openapi/generate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const demoSpec = parse(
  readFileSync(join(root, "apps", "demo-saas", "openapi.yaml"), "utf8"),
) as unknown;

const minimal = (over: Record<string, unknown> = {}) => ({
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  paths: {
    "/things": {
      get: {
        operationId: "listThings",
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: { type: "object", properties: { n: { type: "integer" } } },
              },
            },
          },
        },
      },
    },
  },
  ...over,
});

describe("dereference", () => {
  it("resolves local pointers", () => {
    const result = dereference({
      components: { schemas: { Thing: { type: "object" } } },
      paths: { "/x": { get: { responses: { $ref: "#/components/schemas/Thing" } } } },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.document["paths"] as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    expect(paths["/x"]?.["get"]?.["responses"]).toEqual({ type: "object" });
  });

  it("refuses a remote $ref rather than fetching it", () => {
    const result = dereference({ a: { $ref: "https://evil.example/schema.json" } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain("only local $ref");
  });

  it("refuses a file $ref", () => {
    const result = dereference({ a: { $ref: "./other.yaml#/Thing" } });
    expect(result.ok).toBe(false);
  });

  it("reports an unresolved pointer instead of silently emitting the ref", () => {
    const result = dereference({ a: { $ref: "#/components/schemas/Missing" } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain("unresolved");
  });

  it("cuts a circular $ref rather than hanging", () => {
    const result = dereference({
      components: {
        schemas: { Node: { properties: { next: { $ref: "#/components/schemas/Node" } } } },
      },
      paths: { "/x": { get: { schema: { $ref: "#/components/schemas/Node" } } } },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes("circular"))).toBe(true);
  });

  it("keeps sibling keys as overrides", () => {
    const result = dereference({
      components: { schemas: { T: { type: "string", description: "base" } } },
      x: { $ref: "#/components/schemas/T", description: "override" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document["x"]).toEqual({ type: "string", description: "override" });
  });
});

describe("generation is deterministic", () => {
  it("maps method to side_effect exactly as the doc states", () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/a": {
          get: { operationId: "a", responses: {} },
          post: { operationId: "b", responses: {} },
          put: { operationId: "c", responses: {} },
          patch: { operationId: "d", responses: {} },
          delete: { operationId: "e", responses: {} },
          head: { operationId: "f", responses: {} },
        },
      },
    };

    const result = generateFromSpec(spec);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byId = Object.fromEntries(result.tools.map((t) => [t.operationId, t.side_effect]));
    expect(byId).toEqual({
      a: "read",
      b: "write",
      c: "write",
      d: "write",
      e: "destructive",
      f: "read",
    });
  });

  it("sets a conservative risk that a reviewer is expected to raise, never lower", () => {
    const result = generateFromSpec({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/a": {
          get: { operationId: "r", responses: {} },
          delete: { operationId: "d", responses: {} },
        },
      },
    });
    if (!result.ok) throw new Error("failed");

    const byId = Object.fromEntries(result.tools.map((t) => [t.operationId, t.risk]));
    expect(byId["r"]).toBe("read");
    expect(byId["d"]).toBe("critical");
  });

  it("produces identical output across runs regardless of path order", () => {
    const a = generateFromSpec({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/z": { get: { operationId: "zeta", responses: {} } },
        "/a": { get: { operationId: "alpha", responses: {} } },
      },
    });
    const b = generateFromSpec({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/a": { get: { operationId: "alpha", responses: {} } },
        "/z": { get: { operationId: "zeta", responses: {} } },
      },
    });

    expect(a).toEqual(b);
  });

  it("rejects an operation with no operationId rather than skipping it", () => {
    const result = generateFromSpec({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: { "/a": { get: { responses: {} } } },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain("operationId is required");
  });

  it("rejects duplicate operationIds", () => {
    const result = generateFromSpec({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/a": { get: { operationId: "same", responses: {} } },
        "/b": { get: { operationId: "same", responses: {} } },
      },
    });

    expect(result.ok).toBe(false);
  });

  it("closes both schemas so the argument domain is bounded", () => {
    const result = generateFromSpec(minimal());
    if (!result.ok) throw new Error("failed");

    expect(result.tools[0]?.input["additionalProperties"]).toBe(false);
    expect(result.tools[0]?.output["additionalProperties"]).toBe(false);
  });
});

describe("bind: keeps parameters away from the model", () => {
  const withParams = (name: string, location = "header") => ({
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/a": {
        get: {
          operationId: "op",
          parameters: [{ name, in: location, required: true, schema: { type: "string" } }],
          responses: {},
        },
      },
    },
  });

  it.each([
    ["X-Org-Id", "identity.claims.org_id"],
    ["X-Tenant-Id", "identity.claims.tenant_id"],
    ["X-User-Id", "identity.claims.sub"],
  ])("binds %s from the verified token", (name, expected) => {
    const result = generateFromSpec(withParams(name));
    if (!result.ok) throw new Error("failed");

    const tool = result.tools[0];
    expect(tool?.bind?.[`header.${name}`]).toBe(expected);
    // And crucially: absent from the input schema.
    expect(Object.keys(tool?.input["properties"] as object)).not.toContain(name);
  });

  it("binds an api version to static config", () => {
    const result = generateFromSpec(withParams("api_version", "query"));
    if (!result.ok) throw new Error("failed");

    expect(result.tools[0]?.bind?.["query.api_version"]).toBe('"REPLACE_ME"');
  });

  it("binds the idempotency key to the runtime, not the model", () => {
    // A model-chosen idempotency key is not an idempotency key: it would differ
    // on the retry it exists to deduplicate.
    const result = generateFromSpec(withParams("Idempotency-Key"));
    if (!result.ok) throw new Error("failed");

    expect(result.tools[0]?.bind?.["header.Idempotency-Key"]).toBe("runtime.idempotency_key");
  });

  it("leaves ordinary parameters in the input schema", () => {
    const result = generateFromSpec(withParams("customerId", "path"));
    if (!result.ok) throw new Error("failed");

    expect(Object.keys(result.tools[0]?.input["properties"] as object)).toContain("customerId");
    expect(result.tools[0]?.bind).toBeUndefined();
  });
});

describe("auth binding", () => {
  it("defaults a mutation to a user action token whatever the spec declares", () => {
    // The spec describes how *a* caller authenticates; it cannot know the caller
    // is an agent acting for an end user. Defaulting a mutation to a service
    // credential is the confused-deputy hole.
    const result = generateFromSpec({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
      paths: {
        "/a": {
          post: { operationId: "mutate", security: [{ bearer: [] }], responses: {} },
        },
      },
    });
    if (!result.ok) throw new Error("failed");

    expect(result.tools[0]?.auth).toEqual({ kind: "user_action_token" });
  });

  it("maps a declared scheme for a read", () => {
    const result = generateFromSpec({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
      paths: { "/a": { get: { operationId: "read", security: [{ bearer: [] }], responses: {} } } },
    });
    if (!result.ok) throw new Error("failed");

    expect(result.tools[0]?.auth).toMatchObject({ kind: "service" });
  });
});

describe("nothing is enabled by default", () => {
  it("holds for a generated spec", () => {
    const result = generateFromSpec(demoSpec);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.tools.length).toBeGreaterThan(0);
    expect(result.tools.every((tool) => tool.enabled === false)).toBe(true);
  });

  it("holds for the committed demo file — the artifact, not just the generator", () => {
    const file = parse(
      readFileSync(join(root, "apps", "demo-saas", "keel", "tools", "northwind.yaml"), "utf8"),
    ) as { tools: { operationId: string; enabled: boolean }[] };

    expect(file.tools.length).toBeGreaterThan(0);
    expect(file.tools.every((tool) => tool.enabled === false)).toBe(true);
  });
});

describe("the emitted YAML round-trips", () => {
  it("parses back to the same tools it was generated from", () => {
    // The emitter is hand-written for byte-stable output, so this is the test
    // that stops a quoting bug from silently corrupting a contract.
    const result = generateFromSpec(demoSpec);
    if (!result.ok) throw new Error("failed");

    const yaml = emitToolsYaml("spec.yaml", result.tools);
    const parsed = parse(yaml) as { tools: unknown[] };

    expect(parsed.tools).toEqual(result.tools.map((t) => JSON.parse(JSON.stringify(t))));
  });

  it("is byte-identical when emitted twice", () => {
    const result = generateFromSpec(demoSpec);
    if (!result.ok) throw new Error("failed");

    expect(emitToolsYaml("s", result.tools)).toBe(emitToolsYaml("s", result.tools));
  });

  it("matches the committed file exactly, so a stale artifact fails here", () => {
    const result = generateFromSpec(demoSpec);
    if (!result.ok) throw new Error("failed");

    const committed = readFileSync(
      join(root, "apps", "demo-saas", "keel", "tools", "northwind.yaml"),
      "utf8",
    );

    expect(emitToolsYaml("apps/demo-saas/openapi.yaml", result.tools)).toBe(committed);
  });
});
