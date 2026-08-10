# Session Prompts

One prompt per Claude Code session. Paste the block verbatim as your first message.

**Before session 0.1:** create the repo, commit `CLAUDE.md` and the whole `docs/` folder. That is what makes these prompts short — Claude reads the spec from the repo instead of you re-explaining it every time.

**Model column:** `S` = Sonnet 5 high (default), `O` = Opus 5 high (design-critical). 7 of 33 are Opus. On a Pro plan that split keeps you inside the weekly budget while spending the expensive model where a wrong design compounds.

**Rules for every session**
- One session, one slice unit. Don't chain two.
- End green. Never close a session on a broken build — recovering costs more than the feature did.
- If Claude proposes a design that contradicts `docs/`, stop it and resolve the doc first.
- Commit at the end of every session with a message naming the session id.

---

## Slice 0 — Foundations

### 0.1 · Repo skeleton and CI · **O**

```
Read CLAUDE.md and docs/ROADMAP.md (sections 1 and 2).

Set up the monorepo skeleton exactly as specified in ROADMAP §1: pnpm workspaces,
Turborepo, Biome, TypeScript strict with a shared base config, Vitest, Changesets.

Create every package and service directory with a package.json, tsconfig, and an
index that exports nothing yet. No implementation.

Add .github/workflows/ci.yml running: install, lint, typecheck, build, unit tests.
Add a lint rule (or dependency-cruiser config) that FAILS when anything in packages/
imports from services/ or apps/. That boundary is load-bearing — enforce it in CI, not
by convention.

Plan first. Show me the directory tree and the CI file before creating anything.

Done when: pnpm install && pnpm lint && pnpm typecheck && pnpm build all pass on a
clean clone, and a deliberate packages/->services/ import fails CI.
```

### 0.2 · Local stack and migrations · **S**

```
Read CLAUDE.md, docs/ROADMAP.md §2 (ADR 005, 006), docs/architecture/04 Part B.

Build the local development stack:
- docker-compose.yml: postgres 16 + pgvector, redis, minio, with healthchecks and
  named volumes. No external API keys required to start.
- A forward-only SQL migration harness (no ORM migrations). migrations/NNNN_name.sql
  plus a runner in scripts/. Record applied migrations in a table.
- 0001_init.sql: organizations, users, memberships, projects, environments, api_keys.
  ULID primary keys with type prefixes. org_id on every tenant table. RLS enabled with
  policies, plus a session-variable mechanism for setting the current org.
- A test helper that spins up a throwaway database per integration test file.

Done when: docker compose up succeeds from cold, pnpm migrate applies cleanly, and an
integration test proves RLS blocks a cross-org select.
```

### 0.3 · Contracts package · **O**

```
Read CLAUDE.md and docs/architecture/01 §6 (error taxonomy), 02 §1 (tool contract),
06 §A5 (events). This package is imported by everything and imports nothing — get it
right now, because changing it later touches every file.

Build packages/contracts:
- errors.ts: the full closed error union from doc 01 §6, as discriminated types with
  a retryable predicate and a type guard per member.
- tool.ts: ToolContract, AuthBinding, risk/side_effect enums, Zod schemas, and the
  registration-time validators (timeout required; idempotency forced when side_effect
  != read; cache.vary_by_identity defaults true).
- events.ts: the platform event union from doc 06 §A5.
- agui.ts: our mapping onto AG-UI event types, including which of our events map to
  ACTIVITY (frontend-only) vs TEXT vs INTERRUPT. Document the mapping in comments.
- integrity.ts: the five trust levels and the label-propagation helpers.

Zod is the source of truth; export inferred TS types and a JSON Schema emitter.

Done when: unit tests cover every validator rejection case, and a round-trip test proves
Zod -> JSON Schema -> validation agrees with Zod for every tool contract fixture.
```

### 0.4 · Design system and dashboard shell · **S**

```
Read CLAUDE.md and docs/architecture/05 Part E.

Build packages/ui and the apps/dashboard shell:
- Tokens exactly as specified in 05 §E2. Dark default, light theme, semantic tokens only.
- Primitives: Button, IconButton, Input, Select, Dialog, Popover, DropdownMenu, Tooltip,
  Tabs, Badge, StatusDot, Toast, EmptyState, Skeleton, CodeBlock, KeyValue, Duration.
  Radix underneath. Every one keyboard-operable with a visible 2px focus ring.
- Dashboard shell: Vite + React Router, sidebar nav, auth via Auth.js (email/password
  for now), TanStack Query provider, error boundary, route-level code splitting.
- A /styleguide route rendering every primitive in every state.

Follow §E4 strictly — no gradients, no glassmorphism, no radius above 8px, one shadow
token, mono font for all identifiers.

Done when: /styleguide renders, keyboard-only navigation reaches every control, and a
CI check verifies WCAG AA contrast across the token matrix in both themes.
```

---

## Slice 1 — Read-only agent, end to end

### 1.1 · Demo SaaS · **S**

```
Read CLAUDE.md and docs/ROADMAP.md §6 Slice 1.

Build apps/demo-saas — "Northwind Cloud", a small B2B SaaS. This is both the public demo
and the fixture the entire test suite runs against, so it must be real, not a mock.

- Domain: customers, subscriptions, invoices, orders, usage events.
- REST API with a hand-written OpenAPI 3.1 spec (operationIds required, response schemas
  complete). Session auth plus JWT bearer.
- Seed data: ~200 customers with realistic Indian and international names, plans, login
  recency spread so "inactive for 30 days" returns a meaningful set, invoices in mixed
  currencies including INR.
- Minimal React UI: customer list, customer detail, invoices, analytics, settings.
  Use packages/ui. Client-side routing.
- docs/ content for later knowledge ingestion: refund policy, subscription policy,
  pricing, FAQ. Write real prose, not lorem ipsum.

Done when: the API serves the spec, the UI runs, and a script verifies every operationId
in the spec is reachable.
```

### 1.2 · Core schema · **S**

```
Read docs/architecture/04 Part B.

Migrations 0002-0004: agents, agent_versions, conversations, messages, runs, run_steps,
tools, tool_versions, tool_bindings, identity_configs, end_user_identities.

Follow the doc exactly, including: insert-only version tables (add a trigger that raises
on UPDATE), run_steps partitioned monthly by started_at with (run_id, seq) unique, and
the indexes named in §B1.

Write the repository layer for each with typed queries. No ORM. Every repository method
takes an org scope parameter — make it impossible to call without one at the type level.

Done when: integration tests cover CRUD per repository, the UPDATE trigger fires on a
version table, and a test asserts no repository method can be called without an org scope.
```

### 1.3 · Model providers and routing · **O**

```
Read docs/architecture/01 §5.

Build packages/model-providers:
- The ModelProvider interface exactly as specified, AbortSignal on every method.
- Implementations: Anthropic, and a generic OpenAI-compatible adapter (which must work
  against Ollama and vLLM unmodified — test against a local Ollama).
- Normalised usage/latency/cost/finish_reason across providers.
- Provider errors mapped into our taxonomy.
- The task-class router from §5.1, config-driven, recording every routing decision as a
  structured object the runtime can persist.
- Budget accounting: tokens, calls, cost, wall clock, as a reusable accumulator.

Failover is OFF by default and must be explicitly enabled.

Done when: the same test suite passes against Anthropic and against local Ollama with only
config changed, and cancellation via AbortSignal is proven to stop an in-flight stream.
```

### 1.4 · Agent runtime core · **O**

```
Read docs/architecture/01 §4 carefully — this is the most important session in the project.
Everything later inherits this shape.

Build packages/agent-runtime:
- The state machine from §4.3, but only the read path for now: Authenticating,
  AssemblingContext, ResolvingIntent, Planning, Selecting, Authorizing, Executing,
  Observing, Verifying, Responding, Cancelled, Failed. Leave the approval and workflow
  states declared but unreachable.
- Every transition appends a step through a StepLog port and advances persisted state.
- All I/O through ports: ModelPort, ToolPort, PolicyPort, KnowledgePort, StepLogPort,
  ClockPort, IdPort. The package must have zero runtime dependencies on HTTP or Postgres.
- A replay function: given a step log, re-derive the run's state deterministically.
- Budget checks on entry to Planning and Executing.
- Cancellation as a first-class transition, not an exception.

Plan first and show me the state machine's type signatures before implementing.

Done when: the full lifecycle is unit-tested with in-memory port fakes and no network,
and a replay test proves a recorded step log reproduces identical state.
```

### 1.5 · Policy engine · **O**

```
Read docs/architecture/03 Part C and docs/security/threat-model.md §3 T8.

Build packages/policy-engine:
- The YAML policy document schema from §C2, parsed and validated with Zod.
- A deterministic evaluator: (principal, tool, args, taint, resource, environment, budget)
  -> { effect, rule_id, reason }. Total function, default-deny, no model in the path.
- Argument matchers: exact, subset, comparison operators, and ${principal.*} interpolation.
- The taint invariants I1 and I2 from doc 01 §4.4 as built-in rules.
- Catalogue filtering: given a principal, return the tools they may be offered.
- An explain() that returns the matched rule and why the others didn't match.

No I/O in this package. Pure functions over data.

Done when: a table-driven test suite covers every rule type including precedence and
default-deny, and a property test asserts the evaluator is total (never throws, always
returns a decision) across generated inputs.
```

### 1.6 · OpenAPI import · **S**

```
Read docs/architecture/02 §3.

Build the OpenAPI-to-tool-contract generator in packages/tool-runtime:
- Parse and fully dereference a spec. Reject specs without operationIds.
- Deterministic mapping: method -> side_effect, parameters + requestBody -> input schema,
  2xx response -> output schema, security scheme -> AuthBinding.
- Emit keel/tools/*.yaml with every operation `enabled: false`.
- Support the `bind:` mechanism for parameters sourced from identity claims or static config.
- No LLM anywhere in this path.

Run it against apps/demo-saas/openapi.yaml and commit the generated tool files.

Done when: generation is idempotent (running twice produces an identical diff), and a test
asserts nothing is enabled by default.
```

### 1.7 · Identity · **O**

```
Read docs/architecture/03 Part B and docs/security/threat-model.md T2.

Build packages/identity and the identity module in services/api:
- Verify end-user identity tokens: EdDSA/RS256 via the customer's JWKS with key caching
  and rotation, mandatory aud/iss/exp checks, jti replay cache in Redis, max 10-minute TTL.
- HS256 only when allow_symmetric is explicitly set, with a warning surfaced.
- Session creation bound to (project, environment, subject, jti).
- Anonymous sessions: no history, no user-scoped tools, tighter limits.
- keel-identity helper for Node: keypair generation, JWKS endpoint handler, token minting.
  Wire it into apps/demo-saas.

Security tests are part of this session, not later: expired, wrong aud, wrong iss,
alg:none, alg confusion, replayed jti, unknown kid.

Done when: every attack case above is a passing test, and demo-saas mints tokens the
platform accepts.
```

### 1.8 · AG-UI transport and client core · **S**

```
Read docs/architecture/05 Part B and packages/contracts/src/agui.ts.

Build packages/client (@keel/client), framework-free:
- AG-UI event stream over SSE, with reconnection and resume-from-last-event-id.
- Session lifecycle and identity token refresh (a function, never a static token).
- Event emitter with typed handlers.
- Cancellation.
- Tool dispatch scaffolding (registration only; execution lands in Slice 4).

And the /rt/v1 endpoints in services/api: sessions, conversations, runs (SSE), cancel.

Bundle budget: this package plus the widget core stays under 45KB gzipped. Add the CI
size check now, while it's easy to stay under.

Done when: a Node test harness drives a full run over SSE, receives correctly ordered
AG-UI events, and mid-stream cancellation is observed server-side.
```

### 1.9 · React SDK and widget · **S**

```
Read docs/architecture/05 Part B and Part E6.

Build packages/react (@keel/react):
- KeelProvider (projectId, endpoint, identity function, tools, context).
- Assistant: launcher + panel, message list, composer, streaming text.
- ACTIVITY events render as status lines ("Searching customers…" / "✓ Found 43").
  Never "Thinking…". Never model reasoning.
- Shadow DOM style isolation. Theming via CSS custom properties.
- Stop button while a run is active.
- Accessibility per §E6: focus trap with escape restoration, ARIA live region announcing
  politely (not per token), full keyboard operation, reduced-motion respected.
- i18n scaffolding: no user-visible string literal inside a component.

Embed it in apps/demo-saas.

Done when: the widget answers a question in the demo app, and an axe-core accessibility
test passes with zero violations.
```

### 1.10 · Run detail trace screen · **S**

```
Read docs/architecture/05 §E5 — this is the screen that convinces an engineer we're serious.

Build the run detail page in apps/dashboard:
- Header: agent version, model, tool versions, environment, total latency, total cost.
- Left: step timeline. Each step shows type, duration, status, cost. Virtualised.
- Right: selected step detail — inputs, outputs, policy decision with rule id, error class.
- JSONViewer for payloads with sensitive fields redacted and marked as such.
- Filters by step type and status. Deep-linkable to a specific step.

Show typed execution events only. No chain-of-thought, ever.

Done when: a real run from Slice 1 is fully inspectable, and the policy decision for each
tool call is visible with the rule that produced it.
```

### 1.11 · Slice 1 integration · **O**

```
Read docs/ROADMAP.md §6 Slice 1 exit criteria.

Wire everything into a working vertical slice and prove it end to end:
- Enable three read tools from the generated demo-saas contracts.
- Create an agent version pinning model config, tool selection, and policy version.
- Playwright E2E: log into demo-saas, open the widget, ask "Show me customers who
  haven't logged in for 30 days", assert the correct tool was called with the correct
  arguments, and assert the run detail page shows the full trace including the policy
  decision.
- Add an integration test proving a principal without customers.read is denied, and the
  tool is not even present in the catalogue sent to the model.

Then review the slice against the "no vibe code" checklist in the original brief and give
me an honest list of what's weak. Don't be diplomatic about it.

Done when: the E2E passes, the denial test passes, and you've given me the weaknesses list.
```

---

## Slice 2 — Mutation, authorization, approval

### 2.1 · Action tokens · **O**

```
Read docs/architecture/02 §2.1 and docs/security/threat-model.md T2 and T9.
This is our primary security claim. Get the token binding exactly right.

- Mint action tokens: iss, sub (from the verified identity token), aud (tool audience),
  act (tool@version), args_sha256, run_id, step_id, approval_ref, jti, 60s exp,
  cnf = sha256 of the identity token.
- Verifier middleware packages for Express/Fastify (Node) and FastAPI (Python), each
  under 40 lines of user-facing code. Both verify: identity JWT via own key, action token
  via Keel JWKS, cnf match, args hash match against the actual request body, jti unseen.
- Keel JWKS endpoint with key rotation.
- Wire the Node verifier into apps/demo-saas.

Security tests in this session: replay, argument mutation after signing, wrong audience,
cross-user substitution, expired token, approval_ref reuse.

Done when: every attack above fails as a test, and the demo-saas middleware is under 40
lines. If it's longer, simplify the design — adoption depends on it being trivial.
```

### 2.2 · Approvals and durable suspend · **O**

```
Read docs/architecture/03 §C4 and docs/architecture/01 §4.3.

- Approval records per §C4, persisted, with args_sha256 binding and single-use consumption.
- Runtime states AwaitingApproval / Expired become reachable. The run suspends durably —
  no in-memory hold. A restarted process resumes it.
- AG-UI INTERRUPT emitted; decision arrives via POST /rt/v1/approvals/{id}/decide.
- Two modes: `confirm` (asking user) and `approve` (a different principal with the
  approval permission). These are genuinely different controls — don't collapse them.
- Expiry via a scheduled sweep.

Done when: an integration test approves a suspended run after restarting the API process,
and a test proves an approved call cannot be re-executed with different arguments.
```

### 2.3 · Approval UI · **S**

```
Read docs/architecture/05 §E6 and docs/architecture/03 §C4.

- ApprovalCard in packages/ui: action, affected resource, irreversible consequence, cost —
  in that order. Not a conversational sentence with a Yes button.
- Risk-distinct affordances in the widget: information is prose; an action is a bordered
  card; a destructive action is emphasised with the consequence stated; an approval has
  explicit approve/reject controls.
- Pending approvals list in the dashboard for `approve` mode.
- Approval state survives a page reload — reconnect and re-render the pending interrupt.

Done when: reloading the browser mid-approval restores the card, and the three risk tiers
are visually distinguishable in a screenshot test.
```

### 2.4 · Idempotency, retry, verification · **O**

```
Read docs/architecture/01 §6, docs/architecture/02 §1.

- Idempotency keys derived from the tool contract's key_from paths; sent to the target;
  Idempotency-Key required on mutating API endpoints; dedupe store in Redis with a
  documented TTL.
- Recovery Manager: per-error-class strategy. The retry predicate is exactly
  retryable(error) && tool.idempotent && attempt < max. A destructive tool without an
  idempotency key is NEVER retried — assert this in a test.
- Verification Engine: declared post-conditions on mutations, read back and compare.
- ToolValidationError gets exactly one repair attempt with the validation error fed back,
  then stops.

Done when: a test proves a double-submitted mutation executes once, a test proves a
destructive call is not retried on timeout, and a post-condition failure surfaces as a
typed error rather than a success message.
```

### 2.5 · Cancellation · **S**

```
Read docs/architecture/01 §4.2.

Propagate cancellation the whole way: widget Stop -> API -> runtime -> tool adapter ->
outbound HTTP AbortSignal -> worker job. No orphaned in-flight requests.

Add a cancelled terminal state to runs with a partial trace preserved.

Done when: an integration test starts a run with a slow tool, cancels it, and asserts the
outbound HTTP request was actually aborted server-side — not just that the stream closed.
```

---

## Slice 3 — Knowledge

### 3.1 · Ingestion pipeline and file sources · **S**

```
Read docs/architecture/03 Part A and docs/security/threat-model.md T6.

- The stage-addressable pipeline from §A1. Each stage a pure function over the previous
  stage's stored output, so any stage can be re-run without redoing the earlier ones.
- File sources: PDF, DOCX, MD, TXT, HTML, CSV, JSON. Parsers run in the worker with no
  credentials, constrained memory and a wall clock.
- Malicious document defences from T6: archive limits, PDF JS disabled, XXE disabled,
  SVG rejected, size and time caps.
- content_sha256 change detection; document_versions on change.
- Structure-aware chunking preserving heading paths.

Done when: ingesting the demo-saas docs produces chunks with correct heading paths, a
zip bomb and an XXE document are both rejected safely, and re-ingesting unchanged files
does zero re-parsing.
```

### 3.2 · Crawler and SafeFetch · **S**

```
Read docs/security/threat-model.md T5 — SSRF is reachable from four separate surfaces and
they must all share one implementation.

- SafeFetch: https-only in production, DNS resolution then IP-level denial of loopback,
  link-local (169.254.0.0/16), RFC1918, CGNAT and IPv6 equivalents; DNS pinning so the
  resolved IP is the connected IP; redirects re-validated per hop with a low cap; size
  and time caps.
- Use it for ALL four surfaces: knowledge URLs, OpenAPI base URLs, MCP server URLs,
  webhook targets. One implementation, no exceptions.
- Website crawler on top: sitemap-first, robots-respecting, depth and domain bounded,
  crawl history, per-document error reporting.
- Opt-in private allowlist for self-hosters targeting internal APIs, logged per use.

Done when: the SSRF test suite from the threat model passes, including DNS rebinding,
decimal/octal IP encodings and redirect chains to metadata endpoints.
```

### 3.3 · Retrieval with ACLs · **O**

```
Read docs/architecture/03 §A2 — the ACL predicate must be INSIDE the retrieval query.
Post-filtering leaks through counts, scores and pagination. This is the single most
important correctness property in the knowledge system.

- Local ONNX embeddings (bge-small or e5-small) as the default, so a fresh install needs
  no API key. Hosted embedders behind the same interface.
- Hybrid retrieval: Postgres FTS + pgvector HNSW + metadata filters, fused with RRF.
- Local cross-encoder reranker, pluggable, with a `none` option.
- acl_tags derived from verified identity claims only.
- Context assembly: dedupe, token budget, citations.

Done when: a test proves an unauthorised principal gets zero rows for a restricted
document AND that the result count/score distribution is identical to a world where the
document doesn't exist. Then show me the EXPLAIN plan for the retrieval query.
```

### 3.4 · Retrieval playground · **S**

```
Read docs/architecture/03 §A4 and docs/architecture/05 §E5.

Dashboard page: query in, and show every stage — rewritten query, per-retriever candidates
with raw scores, fused ranking, reranked ranking, what was dropped for budget, and the
exact context block the model would receive.

ACL exclusions shown as a count only, never content.

Principal impersonation in development environments only, and audited.

Done when: a query against the demo knowledge base shows all stages, and impersonation is
proven blocked in the production environment.
```

### 3.5 · Versioning and snapshots · **S**

```
Read docs/architecture/03 §A3.

- knowledge_snapshots and snapshot_members. Agent versions pin a snapshot.
- Runs record the snapshot they retrieved against.
- Source sync state machine with per-document error surfacing in the UI (e.g. "38 of 412
  failed: 31 password-protected, 7 timeouts") — never a silent partial index.
- Re-index, delete, and re-embed operations that reuse unchanged content-addressed chunks.

Done when: changing a document creates a new version, an old run still resolves to the old
version's text, and re-crawling an unchanged site performs zero embedding calls.
```

---

## Slice 4 — Client tools, navigation, context

### 4.1 · Client tool protocol · **O**

```
Read docs/architecture/02 §5.

- defineClientTool: one declaration producing the JSON Schema, the runtime validator, the
  execute() parameter type, and the renderer prop type. Zod-based.
- Dispatch over AG-UI: server requests, browser validates args, executes with a timeout,
  validates the result against the output schema, returns.
- ctx.progress() emits ACTIVITY events (frontend-only, never fed back to the model).
- Client tool results carry `tool` integrity by default; tools reading DOM or third-party
  content must declare `external` and the linter warns when they don't.
- Cancellation reaches a running handler.

Done when: a malformed model tool call becomes a typed ToolValidationError rather than an
exception in customer code, and a handler that returns the wrong shape is rejected before
the result enters model context.
```

### 4.2 · Navigation, context, renderers · **S**

```
Read docs/architecture/02 §6 and §7, and docs/architecture/05 §E6.

- defineRoutes with path, description, params, and a `requires` permission. The navigate_to
  tool's input schema is a CLOSED ENUM of route names — the model must be structurally
  unable to emit an arbitrary URL.
- Routes gated by `requires` are filtered from the catalogue for users lacking it.
- Client context: allowlisted by declaration, size-capped, server-side redaction, and
  `include: "reference_only"` fields where the runtime holds the value and the model gets
  a symbolic handle it can pass to tools but never read.
- Typed tool renderers registered by tool name, props inferred from the output schema.
  Build a CustomerCard renderer for the demo.

Done when: "Open Arun's profile" navigates via the demo app's SPA router, a reference_only
field never appears in any model request payload (assert on the recorded request), and the
customer card renders as a component.
```

---

## Slice 5 — MCP

### 5.1 · MCP client · **O**

```
Read docs/architecture/02 §4. Target MCP 2026-07-28 (stateless core, MRTR, header routing,
cacheable list results) with 2025-11-25 fallback via version negotiation.

- Client with discovery, per-tool opt-in (new tools arrive disabled as "proposed"),
  contract checksums with a diff surfaced on change requiring re-approval.
- Bidirectional schema validation.
- All third-party MCP output labelled `external` integrity.
- OAuth 2.1 with resource indicators; credentials scoped per org.
- Every server URL through SafeFetch.
- MRTR: InputRequiredResult -> Approval Manager -> AG-UI INTERRUPT -> re-issue with
  inputResponses and requestState. Reuse the Slice 2 approval machinery — do not build a
  second human-in-the-loop path.

MCP types must not leak above packages/tool-runtime.

Done when: an external MCP server's tools work under policy, an elicitation surfaces as an
approval card in the widget, and a "rug pull" (server silently changes a tool schema) is
caught by checksum and disabled pending re-approval.
```

### 5.2 · MCP server exposure · **S**

```
Read docs/architecture/02 §4.3.

Expose a project's enabled tools as an MCP server at /mcp, with the SAME policy engine in
front — identical decisions, identical audit trail, identical action tokens.

OAuth 2.1 authorization. Per-principal catalogue filtering.

Done when: Claude Code connects to the demo project's MCP endpoint and can call exactly the
tools the authenticated principal is permitted, with denials appearing in the audit log
identically to widget-originated denials.
```

---

## Slice 6 — Workflows

### 6.1 · Graph schema and validator · **O**

```
Read docs/architecture/04 Part A, especially §A2 and §A3.

Build packages/workflow-engine, validation only this session:
- Node type union and typed state schema per §A2.
- Save-time validation rejecting: unreachable nodes, missing terminal, unbounded loop,
  edge type mismatch, undeclared state read, nonexistent tool reference, a mutation node
  downstream of untrusted-integrity state with no approval node, and client_action in a
  cron-triggered workflow.
- The JSON export format from §A6 — this IS the storage representation, not a
  serialisation of something else.
- Structural diff between two versions.

Done when: every rejection case above has a failing-graph fixture and a passing test, and
export -> import -> export is byte-identical.
```

### 6.2 · Workflow executor · **O**

```
Read docs/architecture/04 §A1 and docs/architecture/01 §4.

Execute graphs on the SAME runtime as free-form runs. One state machine, one trace format,
one approval mechanism, one cancellation path. Two engines would drift within a quarter.

Nodes: start, end, agent, llm, tool, condition, switch, loop (bounded), parallel (capped),
approval, wait (durable), transform (isolated, no I/O), client_action, webhook, subworkflow.

Versions immutable; runs pin workflow_version_id at start and never observe later edits.

Done when: the subscription-cancellation demo journey from the brief runs with real
branching and a real approval, editing the published version doesn't affect an in-flight
run, and a workflow run's trace renders in the same run detail screen as a chat run.
```

### 6.3 · Workflow testing · **S**

```
Read docs/architecture/04 §A5.

- Mocked tool results per §A5. The mock adapter registers ONLY in the test runtime, and
  any run started with mocks is flagged simulated:true on every record it writes.
- Assertions: executed path, never_called, final state.
- keel workflow validate | test | diff.
- Read-only graph view in the dashboard (no editing canvas — that's Phase 2).

Done when: the refund fixture from §A5 passes, and a test proves a simulated run can never
be mistaken for a real one in the activity dashboard.
```

---

## Slice 7 — CLI and config as code

### 7.1 · CLI foundation · **S**

```
Read docs/architecture/05 Part C.

Build packages/cli (keel):
- init: scaffold keel.yaml, generate an identity keypair, .env.example, keel/tools/.
- dev: local runtime with a tunnel, hot-reloading tools and policy.
- tools sync (with --dry-run showing the diff), tools test.
- generate openapi | mcp | types. `generate mcp` writes a server INTO the user's repo —
  committed, reviewed, running in their infrastructure. Deterministic from OpenAPI.
- knowledge sync|status|query, policy test|explain|lint, logs --follow.

Done when: a fresh clone of demo-saas goes from `keel init` to a working agent using only
CLI commands, and `keel tools sync --dry-run` accurately predicts the applied diff.
```

### 7.2 · plan/apply and doctor · **O**

```
Read docs/architecture/05 Part C and Part A.

- keel plan / keel apply with Terraform semantics: plan produces a diff and a plan id;
  apply is idempotent against that plan id; nothing changes without a plan.
- Full project config in git: agents, tools, routes, policies, workflows, knowledge sources.
- Promotion between environments.
- keel doctor with at least 20 checks: JWKS reachability, identity config validity,
  tool/code drift, orphaned tools, ambient-write bindings, missing timeouts, oversized
  context, untested tools, policy default-allow, unpinned model versions, missing
  idempotency on mutations, unreachable MCP servers, stale knowledge sources.

doctor is the highest-leverage command in the product — every incident we hit becomes a
check. Make it easy to add one.

Done when: the whole demo project's config lives in git and deploys to a fresh instance
with keel apply, and doctor catches a deliberately introduced drift and a deliberately
missing timeout.
```

---

## Slice 8 — Observability and hardening

### 8.1 · OpenTelemetry and metrics · **S**

```
Read docs/architecture/06 Part A.

- The span model from §A2, with org/project/run/agent_version on every span.
- W3C traceparent propagated into outbound tool HTTP calls, so a Keel run appears inside
  the customer's own trace.
- Redaction at the exporter, not at the call site — one place to audit.
- Prometheus metrics from §A4.
- Grafana dashboards shipped in deploy/, plus an OTel collector in compose (all optional).
- Activity dashboard: per-tool success rate, failure taxonomy, top failed intents, latency
  and cost percentiles. No vanity counters.

Done when: a demo-saas run's spans appear in a local Jaeger connected to the demo app's own
spans in a single trace.
```

### 8.2 · Webhooks and events · **S**

```
Read docs/architecture/06 §A5 and docs/security/threat-model.md T10.

- One event bus feeding three delivery modes: server webhook, SSE stream, SDK callback.
- HMAC-SHA256 over timestamp.body in Keel-Signature, ±5 minute tolerance, documented
  constant-time verification, per-endpoint secrets with dual-secret rotation.
- At-least-once with exponential backoff and jitter, dead-letter after N attempts,
  replay from the dashboard, delivery log with response codes.
- Receiver example with idempotent handling.

Done when: a forged signature and a replayed timestamp are both rejected in tests, and a
failing endpoint lands in the DLQ and replays successfully after recovery.
```

### 8.3 · Security suite · **O**

```
Read docs/security/threat-model.md §4 in full.

Build apps/vulnerable-demo and the automated security suite. Every suite in §4:
injection corpus (100+ payloads across documents, crawled pages, tickets, MCP results,
filenames, tool outputs), cross-tenant, identity, action token, SSRF, malicious documents,
webhooks, and a direct egress assertion that no request leaves the allowlist during the
entire run.

Wire it into CI as a blocking check with the same status as typecheck.

Then give me an honest assessment: which of the threat model's claimed controls are
actually enforced by these tests, and which are currently aspirational. I want the gap
list, not reassurance.
```

---

## Slice 9 — Evaluation and release

### 9.1 · Evaluation framework · **O**

```
Read docs/architecture/06 Part B.

- Dataset and case schema per §B1, asserting on TRAJECTORY: tool calls with argument
  matchers, never_calls, never_calls_side_effect, ordering, approval expectations, policy
  expectations, citations, budgets. LLM-judge rubrics last and never as the primary signal.
- VCR-style tool fixtures: record once, replay thereafter. Deterministic, free, safe.
- n repetitions with pass rate and confidence interval — never report a single sample.
- keel eval run --dataset X --baseline REF, producing exactly the comparison table in
  §B3 and exiting non-zero on regression against configured thresholds.
- "Promote to eval case" from any run with a thumbs-down, policy denial, recovery or
  rejected approval, with arguments and fixtures pre-filled.
- Contract tests per §B5 as a separate, cheap suite.

Then seed a starting dataset of ~30 cases against the demo app.

Done when: a deliberately degraded prompt produces a red regression report naming the
specific failing cases, and the CI gate blocks the merge.
```

### 9.2 · Release · **S**

```
Read docs/ROADMAP.md §6 Slice 9.

- Docs site (Astro Starlight) covering every subsystem, self-hosting, security, and a
  quickstart that a stranger can follow.
- README: what it is, why, screenshot, 30-second demo, install, code example,
  architecture diagram, features, self-hosting, contributing.
- LICENSE (Apache-2.0), CONTRIBUTING, SECURITY (90-day coordinated disclosure),
  CODE_OF_CONDUCT, ROADMAP, CHANGELOG.
- Issue and PR templates, release automation with signed artifacts and SBOM.
- A smoke test in CI that runs the quickstart against a fresh install from scratch.

Done when: the quickstart smoke test passes in CI on a clean container — that's the only
proof that "git clone && docker compose up" actually works.
```

---

## Reusable prompts

**Continuing a session that ran out of context**

```
Read CLAUDE.md and docs/[the relevant doc].
We are mid-session on [session id]. Already done: [list].
Remaining: [list]. Continue from there. Don't re-do finished work.
Run pnpm typecheck && pnpm test before reporting.
```

**When something is broken**

```
[paste the failing output]

Read CLAUDE.md. Diagnose before changing anything: tell me the root cause and the
smallest fix. Don't refactor surrounding code. Don't add a workaround that hides the
error — if the design is wrong, say so.
```

**End-of-slice review (worth doing every time, use Opus)**

```
Read CLAUDE.md, docs/ROADMAP.md §6 slice [N], and the "no vibe code" checklist below.

Review everything built in this slice against it. Be specific and unsparing — file names
and line references, not general observations. I want the list of what's weak, what's
duplicated, what's untested, and what I'd be embarrassed by in a public repo.

Frontend: state architecture clear? components reusable? accessibility real? loading,
error and empty states real? design consistent? keyboard-friendly? unnecessary animation?
duplicated components?

Backend: domain boundaries clear? errors typed? transactions correct? queries indexed?
permissions enforced server-side? retries safe? mutations idempotent? external
dependencies isolated?

Agent: tools typed? permissions enforced? execution observable? limits enforced? tasks
cancellable? failures recoverable? model usage controlled?

Then propose the three highest-value fixes in priority order. Don't implement yet.
```
