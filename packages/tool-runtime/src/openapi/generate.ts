import { type DereferenceIssue, dereference } from "./dereference.js";

/**
 * OpenAPI → tool contracts (doc 02 §3).
 *
 * Every step is deterministic. There is no model anywhere in this path — not
 * because one could not help with descriptions, but because a non-deterministic
 * import means the list of things an LLM may do to your database changes when
 * you re-run it. Authoring assistance, if it ever lands, writes into the file
 * offline and is reviewed in a pull request.
 *
 * Two rules from the doc, both load-bearing:
 *
 *   1. Nothing is exposed automatically. Every generated operation is
 *      `enabled: false` and a developer turns on what the agent needs.
 *   2. Parameters the model cannot be trusted to invent — tenant ids, API
 *      versions — are `bind:`-sourced from verified claims or static config,
 *      never left in the input schema for the model to fill.
 */

export type GenerateIssue = { readonly path: string; readonly message: string };

export type BindSource = string;

export type GeneratedTool = {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly enabled: false;
  readonly title: string;
  readonly description: string;
  readonly side_effect: "read" | "write" | "destructive";
  readonly risk: "read" | "low" | "high" | "critical";
  readonly auth: Record<string, unknown>;
  readonly timeout_ms: number;
  readonly idempotency: { required: boolean; key_from?: readonly string[] };
  readonly input: Record<string, unknown>;
  readonly output: Record<string, unknown>;
  readonly bind?: Readonly<Record<string, BindSource>>;
};

export type GenerateResult =
  | { readonly ok: true; readonly tools: readonly GeneratedTool[] }
  | { readonly ok: false; readonly issues: readonly (GenerateIssue | DereferenceIssue)[] };

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"] as const;

/**
 * Method → side_effect, exactly as doc 02 §3 states. Mechanical, not a
 * judgement: `side_effect` answers "does it mutate", and `risk` — which is a
 * judgement — is left for a human to set in the generated file.
 */
function sideEffectFor(method: string): "read" | "write" | "destructive" {
  switch (method) {
    case "get":
    case "head":
    case "options":
    case "trace":
      return "read";
    case "delete":
      return "destructive";
    default:
      return "write";
  }
}

/**
 * A conservative starting risk, which a reviewer is expected to raise.
 *
 * Deliberately never higher than the side effect warrants and never lower:
 * guessing "low" for a DELETE would put a destructive operation behind an
 * auto-approve default, and the whole point of the generated file is that a
 * human reads it before anything is enabled.
 */
function riskFor(sideEffect: "read" | "write" | "destructive"): GeneratedTool["risk"] {
  switch (sideEffect) {
    case "read":
      return "read";
    case "write":
      return "high";
    case "destructive":
      return "critical";
  }
}

type SecurityScheme = { type?: string; scheme?: string; flows?: unknown; name?: string };

/**
 * Security scheme → AuthBinding.
 *
 * A mutating operation defaults to `user_action_token` regardless of what the
 * spec declares. The spec describes how *a* caller authenticates; it cannot know
 * that this caller is an agent acting for an end user, and defaulting a mutation
 * to a service credential is the confused-deputy hole doc 02 §2 exists to close.
 */
function authFor(
  schemes: Record<string, SecurityScheme>,
  operationSecurity: readonly Record<string, unknown>[] | undefined,
  sideEffect: "read" | "write" | "destructive",
): Record<string, unknown> {
  if (sideEffect !== "read") return { kind: "user_action_token" };

  const names = (operationSecurity ?? []).flatMap((entry) => Object.keys(entry));
  if (names.length === 0) return { kind: "none" };

  const first = names[0];
  const scheme = first === undefined ? undefined : schemes[first];

  if (scheme?.type === "oauth2") {
    return { kind: "user_oauth", provider: first ?? "oauth", scopes: [] };
  }
  if (scheme?.type === "http" || scheme?.type === "apiKey") {
    return { kind: "service", secret_ref: `env://${(first ?? "API").toUpperCase()}_TOKEN` };
  }

  return { kind: "none" };
}

type Parameter = {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
};

/** Parameters an agent must never supply, sourced from the verified token instead. */
const CLAIM_BOUND: Readonly<Record<string, string>> = {
  "x-org-id": "identity.claims.org_id",
  "x-organization-id": "identity.claims.org_id",
  "x-tenant-id": "identity.claims.tenant_id",
  "x-user-id": "identity.claims.sub",
  org_id: "identity.claims.org_id",
  tenant_id: "identity.claims.tenant_id",
  user_id: "identity.claims.sub",
};

function bindingFor(parameter: Parameter): string | undefined {
  const name = (parameter.name ?? "").toLowerCase();
  const claim = CLAIM_BOUND[name];
  if (claim !== undefined) return claim;

  // The idempotency key is derived by the tool executor from idempotency.key_from
  // (doc 02 §1). Leaving it in the input schema would let the model choose it,
  // and a model-chosen idempotency key is not an idempotency key — it would
  // differ on the retry it exists to deduplicate.
  if (name === "idempotency-key") return "runtime.idempotency_key";

  // Version pins are static config, not something a model should choose.
  if (/^(api[-_]?version|version)$/.test(name)) return '"REPLACE_ME"';

  return undefined;
}

export function generateFromSpec(rawSpec: unknown): GenerateResult {
  const deref = dereference(rawSpec);
  if (!deref.ok) return { ok: false, issues: deref.issues };

  const spec = deref.document;
  const issues: GenerateIssue[] = [];
  const tools: GeneratedTool[] = [];

  const schemes = ((spec["components"] as Record<string, unknown> | undefined)?.[
    "securitySchemes"
  ] ?? {}) as Record<string, SecurityScheme>;

  const paths = (spec["paths"] ?? {}) as Record<string, Record<string, unknown>>;
  const seen = new Set<string>();

  for (const [path, pathItem] of Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof pathItem !== "object" || pathItem === null) continue;

    const pathParameters = (pathItem["parameters"] ?? []) as Parameter[];

    for (const method of METHODS) {
      const operation = pathItem[method] as Record<string, unknown> | undefined;
      if (operation === undefined) continue;

      const operationId = operation["operationId"];
      if (typeof operationId !== "string" || operationId === "") {
        // Rejected, not skipped. A tool derived from an unnamed operation would
        // have no stable identity across regenerations, so every re-import would
        // produce a different catalogue.
        issues.push({
          path: `paths.${path}.${method}`,
          message: "operationId is required; every operation must have a stable name",
        });
        continue;
      }

      if (seen.has(operationId)) {
        issues.push({
          path: `paths.${path}.${method}.operationId`,
          message: `duplicate operationId "${operationId}"`,
        });
        continue;
      }
      seen.add(operationId);

      const sideEffect = sideEffectFor(method);
      const parameters = [...pathParameters, ...((operation["parameters"] ?? []) as Parameter[])];

      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      const bind: Record<string, string> = {};

      for (const parameter of parameters) {
        const name = parameter.name;
        if (name === undefined) continue;

        const binding = bindingFor(parameter);
        if (binding !== undefined) {
          // Bound parameters are removed from the input schema entirely. Leaving
          // them in and hoping the model does not fill them is how an agent ends
          // up choosing its own tenant id (threat-model §T8).
          bind[`${parameter.in ?? "query"}.${name}`] = binding;
          continue;
        }

        properties[name] = {
          ...(parameter.schema ?? { type: "string" }),
          ...(parameter.description === undefined ? {} : { description: parameter.description }),
        };
        if (parameter.required === true) required.push(name);
      }

      const requestBody = operation["requestBody"] as Record<string, unknown> | undefined;
      const bodySchema = (
        (requestBody?.["content"] as Record<string, Record<string, unknown>> | undefined)?.[
          "application/json"
        ] as Record<string, unknown> | undefined
      )?.["schema"] as Record<string, unknown> | undefined;

      if (bodySchema !== undefined) {
        const bodyProperties = (bodySchema["properties"] ?? {}) as Record<string, unknown>;
        for (const [key, value] of Object.entries(bodyProperties)) properties[key] = value;
        for (const key of (bodySchema["required"] ?? []) as string[]) required.push(key);
      }

      const responses = (operation["responses"] ?? {}) as Record<string, Record<string, unknown>>;
      const successCode = Object.keys(responses)
        .filter((code) => /^2\d\d$/.test(code))
        .sort()[0];
      const output =
        successCode === undefined
          ? { type: "object", properties: {}, additionalProperties: false }
          : (((
              responses[successCode]?.["content"] as
                | Record<string, Record<string, unknown>>
                | undefined
            )?.["application/json"]?.["schema"] as Record<string, unknown> | undefined) ?? {
              type: "object",
              properties: {},
              additionalProperties: false,
            });

      tools.push({
        operationId,
        method: method.toUpperCase(),
        path,
        enabled: false,
        title: (operation["summary"] as string | undefined) ?? operationId,
        description:
          (operation["description"] as string | undefined) ??
          (operation["summary"] as string | undefined) ??
          `${method.toUpperCase()} ${path}`,
        side_effect: sideEffect,
        risk: riskFor(sideEffect),
        auth: authFor(
          schemes,
          operation["security"] as readonly Record<string, unknown>[] | undefined,
          sideEffect,
        ),
        timeout_ms: 30_000,
        idempotency:
          sideEffect === "read"
            ? { required: false }
            : { required: true, key_from: required.length > 0 ? [...required].sort() : ["*"] },
        input: {
          type: "object",
          properties,
          ...(required.length === 0 ? {} : { required: [...new Set(required)].sort() }),
          // Closed by construction (threat-model §T8).
          additionalProperties: false,
        },
        output: { ...output, additionalProperties: false },
        ...(Object.keys(bind).length === 0 ? {} : { bind }),
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  // Sorted by operationId so regenerating produces byte-identical output
  // regardless of the order the spec happened to enumerate paths in. Without
  // this, "idempotent" would depend on object key ordering.
  return { ok: true, tools: [...tools].sort((a, b) => a.operationId.localeCompare(b.operationId)) };
}
