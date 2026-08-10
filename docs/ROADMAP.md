# Repository, Technology Decisions, MVP, Roadmap, Risks, Build Order

## 1. Repository structure

```
keel/
├── apps/
│   ├── dashboard/            React + Vite SPA
│   ├── demo-saas/            "Northwind Cloud" — the demo product AND the dev fixture
│   ├── vulnerable-demo/      deliberately weak app for the security suite
│   └── docs/                 documentation site (Astro Starlight or Nextra)
│
├── services/
│   ├── api/                  HTTP surface + module composition (the deployable)
│   └── worker/               ingestion, crawling, embedding, evaluation, webhooks
│
├── packages/
│   ├── contracts/            JSON Schemas, event types, AG-UI extensions — single source of truth
│   ├── agent-runtime/        state machine (pure; ports only)
│   ├── policy-engine/        deterministic decisions (pure)
│   ├── tool-runtime/         adapters: server · client · mcp · openapi · workflow · navigation
│   ├── knowledge-engine/     ingestion pipeline + retrieval planner
│   ├── workflow-engine/      graph validation + execution semantics
│   ├── model-providers/      provider interface + implementations + router
│   ├── client/               @keel/client — framework-free browser core
│   ├── react/                @keel/react
│   ├── node/                 @keel/node server SDK
│   ├── identity/             keel-identity helpers (Node; Python/Go/Java mirrors under sdks/)
│   ├── ui/                   design system primitives (shared: dashboard + widget)
│   └── cli/                  keel
│
├── sdks/python/              generated from OpenAPI + ergonomic layer
├── migrations/               SQL, forward-only, reviewed
├── tests/{integration,e2e,security,load}/
├── docs/{research,architecture,security,adr,guides}/
├── deploy/{docker,compose,helm}/
├── scripts/
└── .github/workflows/
```

Notes: `packages/*` never import `services/*`. `contracts` is imported by everything and imports nothing. The demo app is a first-class citizen — it is the fixture the entire test suite runs against, which keeps it honest.

Tooling: pnpm workspaces + Turborepo, Changesets for releases, Biome for lint/format (one tool, fast), Vitest + Playwright, Docker Bake for images.

## 2. Technology decisions

Each is an ADR under `docs/adr/`. Summarised here with the alternative and the reason.

| # | Decision | Chosen | Alternatives considered | Why |
|---|---|---|---|---|
| 001 | Deployment shape | **Modular monolith + worker** | Microservices | Two processes a self-hoster can reason about. Module boundaries are enforced by lint rules and dependency direction, so extraction later is mechanical. |
| 002 | Primary language | **TypeScript everywhere** | Python backend + TS frontend | One type system from tool schema → runtime → SDK → renderer is the DX claim; a split forces schema duplication. One toolchain also lowers the OSS contribution barrier. Python is a *generated* client, not a second implementation. |
| 003 | Frontend↔agent protocol | **AG-UI** | Proprietary SSE protocol | MIT, ~16 event types, `INTERRUPT` for approvals, `ACTIVITY` for frontend-only status, `STATE_DELTA` via JSON Patch. Implemented by Google, Microsoft, Amazon, Oracle, LangChain, Mastra, PydanticAI. Inventing our own would be strictly worse and would isolate us. |
| 004 | Tool protocol | **MCP 2026-07-28**, 2025-11-25 fallback | Custom RPC | Stateless core, MRTR, header routing. MRTR maps directly onto our approval flow. |
| 005 | Database | **PostgreSQL 16 + pgvector** | Dedicated vector DB (Qdrant/Weaviate) | One datastore for relational, full-text and vector means the ACL predicate lives in the *same query* as the similarity search — the security property we care most about. A separate vector store makes correct permission filtering hard and adds a service to every self-host. Revisit past ~10M chunks. |
| 006 | Queue | **Postgres `FOR UPDATE SKIP LOCKED` + Redis streams** | Temporal, Celery, BullMQ | Temporal is the technically strongest option for durable execution and the wrong one for `docker compose up` — it is a whole cluster to operate. Our durability comes from the persisted step log, which we need regardless. Postgres queueing handles our throughput comfortably; ADR records Temporal as the Phase 3 option for customers running high volume. |
| 007 | Durable execution | **Own step-log executor** | Temporal, Restate, DBOS | Follows from 006. Also gives us deterministic replay for free, which we need for evaluation anyway. |
| 008 | Validation | **Zod → JSON Schema** | JSON Schema first, TypeBox | Developers author in Zod (best TS ergonomics, and it's what the tool-definition API exposes); we emit JSON Schema for models and storage. Round-trip is tested. |
| 009 | Policy language | **Declarative YAML + typed evaluator** | OPA/Rego, Cedar | Cedar is genuinely better designed; Rego is more powerful. Both are a new language for our users to learn, and both add a dependency to the security-critical path. Our matcher covers the documented cases, is diffable by a product manager, and has an escape hatch to a plugin. Reconsider seriously if custom-role demand appears. |
| 010 | Dashboard framework | **Vite SPA** | Next.js | Authenticated tool; SSR adds a server to operate in every self-host for no user benefit. Next.js stays for the docs site. |
| 011 | Workflow canvas | **XYFlow** | Hand-rolled, Rete, Litegraph | Mature, accessible, maintained. Not a place to innovate. |
| 012 | Observability | **OpenTelemetry** | Proprietary tracing, LangSmith | Correlation into the customer's existing APM is the whole point. Vendor-neutral. |
| 013 | Auth (dashboard) | **Auth.js + optional OIDC** | Build our own, Clerk/WorkOS | Self-hosting rules out a mandatory SaaS dependency. OIDC covers enterprise SSO without an enterprise SSO project. |
| 014 | Secrets | **Provider interface** (env / file / Vault / cloud KMS) | Env only | Env-only fails the first serious deployment review. |
| 015 | Embeddings default | **Local ONNX (bge-small / e5-small) with pluggable hosted** | Hosted default | `docker compose up` must produce a working system with no API key. A hosted embedding requirement breaks the self-hosting promise at step one. |

## 3. MVP

The brief's MVP list is roughly 9–12 months for a small team. This one is scoped to be **complete rather than broad** — every included item works end to end, with tests, and nothing is stubbed.

### In

```
✓ docker compose up → dashboard + API + worker + Postgres + Redis + MinIO, no external keys required
✓ Agent runtime: full lifecycle, durable, cancellable, resumable, replayable
✓ Model providers: Anthropic, OpenAI, OpenAI-compatible (Ollama/vLLM); routing by task class; budgets
✓ Identity: asymmetric JWT + JWKS, sessions, anonymous mode, keel-identity helpers (Node + Python)
✓ Policy engine: default-deny, risk tiers, per-principal tool filtering, taint invariants I1/I2, explain
✓ Approvals: durable pause/resume, confirm + approve modes, AG-UI INTERRUPT
✓ Tools: unified contract; server, client, OpenAPI, MCP, navigation targets
✓ Action tokens + verifier middleware (Node, Python) with docs
✓ Knowledge: files + website crawl; hybrid retrieval (FTS + pgvector + RRF + local rerank);
  per-document ACLs enforced in-query; content-hash versioning; retrieval playground
✓ Workflows: engine + YAML + validation + mocked test runs + versioning. NO visual builder.
✓ SDKs: @keel/client, @keel/react (typed client tools, typed renderers, routes, context)
✓ Script-tag embed built on @keel/client
✓ Dashboard: agents, tools, knowledge, conversations, run detail (the trace screen), policy, settings
✓ REST API v1 + OpenAPI spec + generated Python client
✓ CLI: init, dev, tools sync/test, generate openapi/mcp/types, knowledge, policy, logs,
  plan/apply, doctor
✓ Webhooks: signed, retried, dead-lettered
✓ OpenTelemetry tracing + Prometheus metrics + Grafana dashboards
✓ Demo SaaS (Northwind Cloud) with OpenAPI spec, auth, docs, seed data
✓ Tests: unit, integration, e2e, security suite in CI
✓ Docs: getting started, concepts, every subsystem, self-hosting, security, threat model
```

### Deliberately out of MVP

| Deferred | Reason |
|---|---|
| Visual workflow builder | The engine must be right first. YAML + validation is genuinely usable; a canvas over a weak engine is a demo. |
| Evaluation **UI** | The CLI + CI gate delivers the value. Dashboard UI is Phase 2. (The framework itself ships in MVP-adjacent Phase 2 start — see build order.) |
| Notion connector | One connector, mid-value; the interface exists so it's a 2-day add later. |
| React Native / Flutter | Real work, and `@keel/client` makes it additive. Crow is ahead here and will stay ahead for a while. |
| Google/Azure/Bedrock providers | The OpenAI-compatible adapter covers a surprising amount; native adapters are mechanical. |
| OAuth-per-user credentials | Action tokens cover the primary case. |
| Multi-language configuration | Models handle this well without product surface; add when a user asks. |
| Browser/desktop execution targets | Interface designed (`ExecutionTarget`), implementation deferred to Phase 3. |
| Kubernetes/Helm | Compose first. Helm when someone actually needs it. |
| Cloud offering | Phase 4 at the earliest. |

## 4. Phases

**Phase 1 — MVP (above).** Target: a developer with an existing SaaS and an OpenAPI spec goes from clone to a working, permission-aware, observable agent in an afternoon.

**Phase 2 — Trust and scale.** Evaluation framework + CI gate + dashboard UI · production-promotion candidate cases from failures · visual workflow builder (XYFlow) · scheduled and webhook triggers · Notion + Confluence + Drive connectors · Google/Azure/Bedrock providers · advanced routing with measured policies · cost dashboards and budgets UI · OAuth per-user credentials · plugin interfaces published and versioned.

**Phase 3 — Reach.** React Native + Flutter SDKs · browser execution target (the `ExecutionTarget` interface exists from day one, so this is additive) · distributed workers · Temporal option for high-volume durable execution · advanced recovery strategies · Helm chart · multi-region knowledge · plugin marketplace.

**Phase 4 — Optional cloud.** Managed deployment, managed models, managed workers, enterprise SSO/SCIM, advanced audit and residency, support. **Constraint: no capability is removed from the OSS core to create a cloud upsell.** The commercial line is operations and scale, not features. Getting this wrong destroys the community that makes the OSS core worth having, and it is the most common way projects in this shape die.

## 5. Risks

| # | Risk | Severity | Response |
|---|---|---|---|
| R1 | **CopilotKit occupies the space** — $27M, 34.7k stars, AG-UI adopted by four hyperscalers | High | Don't compete on the frontend layer. Adopt AG-UI, ship an AG-UI-compatible backend, and win on the governed control plane they explicitly leave to the developer. Frame as complementary in the README, honestly. |
| R2 | **Prompt injection is unsolvable** and a public incident would be existential for a security-positioned product | High | Say so first, in our own docs. Ship architectural mitigations (planner/extractor split, taint invariants, egress allowlist), a public attack corpus in CI, and a real disclosure process. Never claim immunity. |
| R3 | **Scope is enormous**; classic OSS failure is 40% of everything | High | Vertical slices, each shipped complete. Cut list above is binding. `keel doctor` and the run-detail screen before breadth. |
| R4 | **Self-hosting is a support burden** | Medium-High | `keel doctor`, one compose file, no external keys required for first run, pinned images, a smoke test that runs against a fresh install in CI. |
| R5 | **Action-token middleware is friction** and adoption stalls at "just use a service key" | Medium-High | Keep it under 30 lines. Ship verified copy-paste snippets for Express/Fastify/FastAPI/Django/Spring/Rails. Make the insecure path work but visibly warn. If adoption still stalls, that's a signal to reconsider the ergonomics, not to weaken the model. |
| R6 | **MCP spec churn** — 2026-07-28 was a breaking revision three months ago | Medium | Isolate behind our adapter; version-negotiate; the new formal deprecation policy helps. Never leak MCP types above `tool-runtime`. |
| R7 | **Eval maintenance cost** — suites rot | Medium | Fixtures recorded, not hand-written. Promotion from production failures. Suite health (staleness, flakiness) is itself a dashboard. |
| R8 | **Model behaviour drift** breaks tool selection with no code change | Medium | Pin model versions per agent version. Scheduled eval runs against pinned + latest, alert on divergence. |
| R9 | **Postgres+pgvector ceiling** | Medium | Retrieval behind an interface from day one; benchmark published; migration path documented. Not a day-one problem. |
| R10 | **OSS/commercial tension** | Medium | Apache-2.0 core, decided now and stated in the README. No open-core feature-gating. Revenue from operations. |
| R11 | **Solo/small-team velocity** vs a funded competitor | Medium | Depth over breadth; the security and evaluation stories are ones a hosted vendor cannot easily copy, because they'd have to give up the trusted-header model and build eval into a product they've already shipped. |
| R12 | **Demo app becomes a maintenance tax** | Low-Medium | It's the test fixture, so it's exercised on every PR. That's the point. |

## 6. Build order

Vertical slices. Each ends **implemented → tested → running → inspected → documented**, and nothing proceeds on a broken foundation.

**Slice 0 — Foundations (week 1–2).**
Monorepo, CI (lint, typecheck, unit, build, Docker), `contracts` package, migrations harness, compose stack up with Postgres/Redis/MinIO, design tokens + first six primitives, ADRs 001–015 written. *Exit: `docker compose up` serves an empty authenticated dashboard; CI green.*

**Slice 1 — Read-only agent, end to end (week 3–5).** ← the slice that proves the thesis
Demo SaaS with OpenAPI + seed data → OpenAPI import → three read tools → identity (JWKS) → policy engine with default-deny and read-allow → runtime through `Executing`/`Responding` → AG-UI over SSE → `@keel/client` + `@keel/react` → run + steps persisted → run-detail trace screen.
*Exit: "Show me customers who haven't logged in for 30 days" works in the demo app, and the trace screen explains exactly how — including the policy decision.*

**Slice 2 — Mutation with authorization and approval (week 6–8).**
Action tokens + verifier middleware in the demo backend · risk tiers · approval records, durable suspend/resume, `INTERRUPT` · approval card UI · idempotency · post-condition verification · error taxonomy and recovery · cancellation propagated to the worker.
*Exit: "Upgrade Arun to Pro" pauses for confirmation, executes once even if double-clicked, verifies the result, and appears in the audit log. Killing the API mid-approval loses nothing.*

**Slice 3 — Knowledge (week 9–11).**
Ingestion pipeline · file + website sources · chunking · local embeddings · hybrid retrieval with RRF · ACL predicate in-query · versioning + snapshots · retrieval playground · citations in the widget.
*Exit: "Explain how refunds work" answers from documents with citations; an unauthorised principal provably cannot retrieve the internal policy doc, verified by test.*

**Slice 4 — Client tools, navigation, context (week 12–13).**
`defineClientTool` + `defineRoutes` · client dispatch over AG-UI · argument/result validation client-side · `ACTIVITY` progress · typed renderers · allowlisted context with reference-only fields.
*Exit: "Open Arun's profile" navigates via the SPA router; "Export this list" downloads a CSV; the customer card renders as a component.*

**Slice 5 — MCP both directions (week 14–15).**
Client for 2026-07-28 + fallback · per-tool opt-in with checksum diffs · MRTR → approvals · external content tainted · our tools exposed as an MCP server behind the policy engine.
*Exit: an external MCP server's tools are usable under policy; an MCP elicitation surfaces as an approval in the widget; the demo agent is reachable from Claude Code with the same permissions.*

**Slice 6 — Workflows (week 16–18).**
Graph schema + save-time validation · executor on the same runtime · conditions, switch, bounded loops, parallel, approval, wait, transform · versioning + pinning · mocked test runs · export/import · the subscription-cancellation demo journey.
*Exit: the demo journey runs with branching and approval; `keel workflow test` passes with mocked tools; editing the published version does not affect an in-flight run.*

**Slice 7 — CLI and config as code (week 19–20).**
`init`, `dev`, `tools sync`, `generate openapi|mcp|types`, `policy test|explain`, `plan`/`apply`, `doctor`.
*Exit: the entire demo project's configuration lives in git and deploys to a fresh instance with `keel apply`.*

**Slice 8 — Observability and hardening (week 21–23).**
OTel spans end to end · metrics + Grafana dashboards · webhooks with signing/retry/DLQ · activity dashboard with failure taxonomy · the full security suite (`vulnerable-demo` + attack corpus) in CI · rate limits + budgets enforced · load benchmark published.
*Exit: security suite green in CI; a run's spans appear in the demo app's own Jaeger; documented p50/p95 for first output and tool execution.*

**Slice 9 — Release (week 24–26).**
Evaluation framework + CI gate (moved here from Phase 2 because it gates our own releases) · documentation site · README with a 30-second demo · LICENSE, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, ROADMAP, CHANGELOG · issue/PR templates · release automation with signed artifacts and SBOM · public demo instance.
*Exit: a stranger clones the repo, runs `docker compose up`, follows the quickstart, and has a working agent against the demo app in under 15 minutes — verified by someone who didn't build it.*

## 7. ADR index

```
001 modular monolith        002 TypeScript everywhere      003 AG-UI as wire protocol
004 MCP 2026-07-28 target   005 Postgres + pgvector        006 Postgres/Redis queueing
007 own durable executor    008 Zod → JSON Schema          009 declarative policy language
010 Vite SPA dashboard      011 XYFlow canvas              012 OpenTelemetry
013 Auth.js + OIDC          014 secret provider interface  015 local embeddings by default
016 action token design     017 taint invariants I1/I2     018 no chain-of-thought exposure
019 Apache-2.0, no open core 020 evaluation on trajectories
```

Each: Context · Problem · Decision · Alternatives · Consequences · Revisit-when.
