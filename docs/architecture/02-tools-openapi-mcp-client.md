# 02 — Tool Architecture

## 1. One contract, many execution targets

Everything the agent can do is a **Tool**, and every tool is the same versioned record regardless of where it runs. The model sees a uniform catalogue; the runtime sees a uniform contract; the policy engine sees a uniform decision input.

```ts
interface ToolContract {
  name: string;                    // snake_case, stable, unique per project
  version: number;                 // bumped on any schema/semantic change
  title: string;
  description: string;             // the single biggest lever on selection accuracy
  input: JSONSchema;
  output: JSONSchema;

  target: "server" | "client" | "mcp" | "openapi" | "workflow" | "knowledge" | "navigation";
  side_effect: "read" | "write" | "destructive";
  risk: "read" | "low" | "high" | "critical";

  auth: AuthBinding;               // see §2
  accepts_untrusted_args: boolean; // default false — governs invariant I1
  egress?: string[];               // allowlisted destinations for invariant I2

  timeout_ms: number;              // required, no default-forever
  retry: { max: number; backoff: "none" | "exponential"; on: ErrorClass[] };
  idempotency: { required: boolean; key_from?: string[] };  // arg paths
  cache?: { ttl_s: number; key_from: string[]; vary_by_identity: boolean };
  concurrency?: { group?: string; max?: number };

  examples?: Array<{ input: unknown; output: unknown; note?: string }>;
  renderer?: string;               // renderer id resolved client-side
}
```

Design notes on the fields that carry real weight:

- **`side_effect` and `risk` are separate.** `side_effect` is mechanical (does it mutate?) and drives retry/idempotency/caching. `risk` is business judgment (how bad if wrong?) and drives approval. `export_all_customers` is a *read* with *high* risk. Collapsing them into one field is the most common mistake in this space.
- **`timeout_ms` is required.** No tool may hang forever. The schema rejects absence.
- **`idempotency.required` is forced to `true` when `side_effect != read`.** Validation error at registration time, not a runtime surprise.
- **`cache.vary_by_identity` defaults to `true`.** Caching a per-user read across users is a cross-tenant leak; you must opt out explicitly and the policy linter warns.
- **`version` is on the tool, not the project.** A run records exactly which tool versions it used, which is what makes a six-week-old trace intelligible.

### Risk → approval policy (defaults, per environment)

| Risk | development | staging | production |
|---|---|---|---|
| `read` | auto | auto | auto |
| `low` | auto | auto | auto |
| `high` | auto | confirm | confirm |
| `critical` | auto | approve (any admin) | approve (admin, out-of-band) |

`confirm` = the asking user confirms in the widget. `approve` = a *different* principal with an approval permission decides, optionally from the dashboard rather than the widget. That distinction matters: "the user clicked yes" is not an authorization control when the user is the attacker.

## 2. Credential binding — the confused-deputy fix

This is the core security difference from Crow, so it gets specified precisely.

```ts
type AuthBinding =
  | { kind: "none" }
  | { kind: "service"; secret_ref: string }          // machine identity, READ-ONLY tools only by default
  | { kind: "user_action_token" }                    // default for anything mutating
  | { kind: "user_oauth"; provider: string; scopes: string[] }
  | { kind: "org_credential"; provider: string };
```

**Rule enforced at registration:** a tool with `side_effect != "read"` may not use `kind: "service"` unless the project explicitly sets `allow_ambient_write: true` and the reviewer acknowledges it in config. Ambient admin credentials plus an LLM is how you build a machine that can do anything to anyone.

### 2.1 Action tokens

Crow's model: `X-Service-Key` proves *a trusted service is calling*; `X-User-ID` is then believed. That is one compromised hop away from total cross-user access, and the customer's backend cannot tell.

Ours: the customer's backend gets a token that is **chained to the identity token their own IdP minted** and **bound to this specific call**.

```mermaid
sequenceDiagram
    participant App as Customer backend
    participant FE as Widget
    participant KL as Keel runtime
    participant API as Customer API

    App->>FE: identity JWT (EdDSA, aud=keel:proj_x, jti, exp 10m)
    FE->>KL: AG-UI run + identity JWT
    KL->>KL: verify via customer JWKS; bind to session
    Note over KL: policy allows tool call
    KL->>KL: mint action token:<br/>{ iss: keel, sub: <identity.sub>,<br/>  aud: <tool.audience>, act: tool@v,<br/>  args_sha256, run_id, step_id,<br/>  approval_ref?, jti, exp: 60s,<br/>  cnf: sha256(identity_jwt) }
    KL->>API: Authorization: Bearer <action_token><br/>Keel-Identity: <original identity JWT>
    API->>API: verify BOTH:<br/>1. identity JWT via own key ✓<br/>2. action token via Keel JWKS ✓<br/>3. cnf matches identity ✓<br/>4. args hash matches body ✓<br/>5. jti unseen ✓
    API-->>KL: result
```

What this buys, concretely:

| Attack | Crow's model | Action tokens |
|---|---|---|
| Control plane compromised, attacker asserts `X-User-ID: victim` | Succeeds | Fails — no valid identity JWT for the victim exists to chain from |
| Token captured and replayed | Succeeds until `exp` (1h) | Fails — 60s TTL and single-use `jti` |
| Replayed against a *different* operation or different arguments | Succeeds | Fails — `aud` and `args_sha256` bind the token to one call |
| Approved action re-executed later | Undetectable | Fails — `approval_ref` is single-use and audited |

Cost to the customer: one middleware, ~30 lines, published as a copy-pasteable snippet and as `@keel/verify` (Node), `keel-verify` (Python, Go). We must keep this genuinely small or nobody adopts it; if it's a burden the whole security story evaporates.

Fallback for teams who won't add middleware: `kind: "service"` for read-only tools, with a loud warning in the dashboard and in `keel doctor`. We meet people where they are, but we don't pretend it's equivalent.

## 3. OpenAPI tools — deterministic, opt-in

```
openapi.(json|yaml)
   │
   ├─ parse + $ref dereference + validate      deterministic
   ├─ enumerate operations (operationId req.)  deterministic
   ├─ infer side_effect from method            GET/HEAD→read, POST/PUT/PATCH→write, DELETE→destructive
   ├─ map security scheme → AuthBinding        deterministic
   ├─ generate input schema from params+body   deterministic
   ├─ generate output schema from 2xx          deterministic
   │
   ├─ [optional, offline] LLM drafts titles/descriptions/examples
   │      → written to keel/tools/*.yaml
   │      → reviewed in a pull request
   │      → never invoked at runtime
   │
   └─ developer opts in per operation          nothing is exposed by default
```

Two rules that separate this from Crow's importer:

1. **Nothing is exposed automatically.** The generated file lists every operation with `enabled: false`; you turn on what the agent needs. Default-deny is the only sane posture when the artifact under discussion is "a list of things an LLM may do to your database."
2. **The LLM never runs at request time.** Descriptions are an artifact in your repo, reviewed like code. Non-determinism is confined to authoring.

Header/query parameters not derivable from the model's inputs (tenant IDs, API versions) are bound from the identity claims or from static config — never left for the model to invent:

```yaml
- operationId: getCustomer
  enabled: true
  risk: read
  bind:
    header.X-Org-Id: identity.claims.org_id     # from the verified token
    query.api_version: "2026-01-01"             # static
  description: "Fetch a customer by id. Returns plan, status and contact details."
```

**Spec-less backends.** Crow's Envoy wins here today, and we need an answer: `keel generate --from-source` runs a code-reading pass (opt-in, explicit directory list, shows exactly what it would upload, `--local-model` supported) whose output is an **OpenAPI spec written into your repo**, not a hosted server. You then review the spec and generate tools from it deterministically. Same convenience, reviewable artifact, no source leaving your machine if you point it at a local model.

## 4. MCP integration

**Target: MCP `2026-07-28`** (stateless core, header-based routing, cacheable list results, Multi Round-Trip Requests). Negotiate down to `2025-11-25` when a server advertises it.

### 4.1 As a client (external and first-party MCP servers)

- **Discovery** → `server/discover`, tools cached with the spec's cacheability semantics; refreshed on TTL or explicit `keel tools sync`.
- **Import is opt-in per tool**, same default-deny as OpenAPI. A server that adds a tool tomorrow does not get to act tomorrow. (This also closes the "rug-pull" class of MCP supply-chain attack.)
- **Schema validation both ways.** Arguments validated against the server's input schema before sending; results validated against the declared output schema before entering the run. An unvalidated third-party payload becomes model context otherwise.
- **Provenance:** all third-party MCP output is labelled `external` — untrusted integrity — and therefore cannot drive a mutating call without approval (invariant I1).
- **Auth** follows the spec's OAuth 2.1 / resource-indicator model. Third-party server credentials are per-org or per-user, never shared across tenants.
- **Egress:** every MCP endpoint URL passes the SSRF guard (§6 of the threat model).

### 4.2 MRTR → approvals, one path

The 2026-07-28 spec replaced server-initiated elicitation with Multi Round-Trip Requests: a server returns `InputRequiredResult` with `inputRequests` and an opaque `requestState`; the client gathers answers and re-issues the original call with `inputResponses`. This maps cleanly onto machinery we already need:

```
MCP InputRequiredResult
        ↓
Approval Manager: persist { requestState, tool, args, run_id } as an approval record
        ↓
AG-UI INTERRUPT  →  widget renders the request (approval card / form)
        ↓
user decides (durable — survives reload; run is suspended, not held in memory)
        ↓
re-issue tool call with inputResponses + requestState
```

One human-in-the-loop implementation covers MCP elicitation, our own risk-based confirmations, and workflow approval nodes. No parallel code paths.

### 4.3 As a server

Expose a project's enabled tools as an MCP server so the customer's own agents, Claude Code, or an internal ops bot can use the same governed tool surface — **with the same policy engine in front**. This is a small amount of work for a large amount of leverage: it means our policy and audit layer protects tool use that doesn't come through our widget at all.

## 5. Client-side tools

The differentiator here is not that they exist (Crow has them) but that **schema and handler are one declaration**:

```ts
export const exportCurrentView = defineClientTool({
  name: "export_current_view",
  description: "Export the rows currently visible in the table to CSV.",
  input: z.object({ fileName: z.string().default("export") }),
  output: z.object({ rows: z.number() }),
  risk: "low",
  timeoutMs: 15_000,
  execute: async ({ fileName }, ctx) => {
    ctx.progress("Building CSV…");        // AG-UI ACTIVITY — frontend-only, not fed to the model
    const rows = downloadCsv(store.visibleRows(), fileName);
    return { rows };                       // validated against output schema before returning
  },
});
```

Runtime guarantees:

- **Arguments are validated in the browser** before `execute` runs. A malformed tool call from the model becomes a typed `ToolValidationError`, not an exception inside customer code.
- **Results are validated** against the output schema before being sent back — a client tool cannot smuggle arbitrary shapes into model context.
- **Client tool results are `tool` integrity, not `user`.** A tool that reads DOM content or a third-party iframe should declare `integrity: "external"` and the linter warns if it doesn't.
- **Timeout and cancellation** are enforced by the SDK; a hung handler fails the step instead of the run.
- **Progress** goes through `ACTIVITY` events, which by design are not sent back to the model — status text can't become an injection vector.
- **Sync:** `keel tools sync` uploads contracts derived from the code. `keel doctor` fails CI if the deployed catalogue and the code disagree. Crow's manual JSON upload is exactly the drift this removes.

## 6. Navigation

Crow's design instinct here is right and we keep it: **the model chooses a route name; code resolves the URL.** We move the route table into the codebase so it can't drift from the router.

```ts
export const routes = defineRoutes({
  customer_detail: {
    path: "/customers/:customerId",
    description: "A single customer: plan, billing status, activity.",
    params: { customerId: { description: "Customer id from the customers API" } },
    requires: "customers.read",     // policy-aware: not offered to users without it
  },
  analytics: { path: "/analytics", description: "Revenue and usage dashboards." },
});
```

`navigate` defaults to the SPA router if one is provided, else `location.assign`. The `navigate_to` tool's input schema is a **closed enum of route names** — the model literally cannot emit an arbitrary URL, so open-redirect through the agent is structurally impossible rather than filtered.

Routes gated by `requires` are filtered out of the catalogue for users lacking the permission, so the agent never offers a page the user can't open.

## 7. Client context

```ts
context={{ route: "customer_detail", params: { customerId }, orgId, locale, selection }}
```

- **Allowlisted by declaration.** No DOM scraping, no automatic state capture. The developer names the fields.
- **Server-side redaction** runs before context reaches a model: PII detectors plus project-configured patterns. A field can be marked `include: "reference_only"`, meaning the runtime holds the value and gives the model a symbolic handle (`$sel_1`) it can pass to tools but never read. This is the CaMeL symbolic-variable idea applied to app state, and it is how "act on the selected records" works without pouring customer PII into a third-party model.
- **Size-capped** and truncated deterministically; oversize context is a warning in `keel doctor`, not silent truncation.

## 8. Tool fallback chains

```yaml
tools:
  get_customer:
    primary:  openapi:getCustomer
    fallback: [ mcp:crm/get_customer ]
    on: [ ToolUnavailableError, ToolTimeoutError ]
```

Fallback is allowed only when both tools share a compatible output schema (checked at registration) and only for `side_effect: read`. Falling back on a mutation risks double execution; if a customer needs it, they need idempotency keys and an explicit acknowledgement.

## 9. Determinism budget

Use the model only where reasoning is required. Everything below runs as code:

| Task | Deterministic mechanism |
|---|---|
| Route resolution | Route table lookup |
| Argument validation | JSON Schema / Zod |
| Permission decision | Policy engine |
| Known intent → known tool | Intent rules with confidence threshold |
| Field extraction from a structured tool result | JSONPath transform declared on the tool |
| Unit/currency/date normalisation | Library |
| Idempotency key derivation | `key_from` arg paths |
| Post-condition verification | Read-back assertion |

Target for the demo app: **≤ 2 model calls for the median task**. That is a number we measure and publish in the benchmark doc — it is simultaneously a cost, latency and reliability metric, which is why it's worth optimising deliberately rather than accidentally.
