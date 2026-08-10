# Competitive Analysis

**Researched:** 9 August 2026. All Crow claims below come from `docs.usecrow.ai` (fetched directly, page-by-page) and Crow's YC profile. Adjacent-product claims are cited to their sources. Anything I could not verify from primary material is marked *unverified* rather than assumed.

---

## 1. What Crow actually is

Crow (YC W2026, founded by Jai Bhatia and Aryan Vij, 2 people, San Francisco) is a **hosted, closed-source AI agent layer for existing SaaS products**. You point it at your knowledge and your API, and it gives your users a chat widget that can answer questions and take actions inside your product.

The integration surface is deliberately tiny:

```html
<script src="https://api.usecrow.org/static/crow-widget.js"
        data-api-url="https://api.usecrow.org"
        data-product-id="YOUR_PRODUCT_ID"></script>
```

or `npm install @usecrow/client @usecrow/ui` → `<CrowWidget productId=... apiUrl=... />`.

Their own four-step framing: **Embed → Configure (Sandbox) → Integrate (OpenAPI or MCP) → Deploy (Activity)**.

### 1.1 Verified capability inventory

| Area | What the docs say |
|---|---|
| **Embedding** | Script tag, React SDK (`@usecrow/ui`, exports `CrowWidget` and `CrowCopilot`), React Native, Flutter. |
| **Knowledge base** | Three sources only: uploaded **Files**, **Website** crawl, **Notion**. Files and Website update by *manual* re-upload / re-crawl; Notion is live. No documented chunking config, no retrieval tuning, no reranking, no per-document permissions, no versioning. |
| **API integration** | Upload an OpenAPI spec; endpoints become tools; you check/uncheck which operations the agent may call. |
| **API auth** | Three modes: static **API Key** header, static **Bearer**, or **JWT Forward** (forwards the Crow identity token to your API). |
| **MCP** | Connect external MCP servers; connect your own MCP server (Streamable HTTP required for header support); toggle whole servers or individual tools. |
| **Identity** | Your backend mints a **separate Crow-scoped JWT**, HS256, signed with a shared `CROW_VERIFICATION_SECRET`. Required claims: `user_id`, `exp`. Optional: `email`, `name`. Frontend calls `window.crow('identify', {token})` or passes `getIdentityToken` to the React component (auto-refreshes). `resetUser` on logout. |
| **Identity → tools** | Dashboard "header mappings" project JWT claims into HTTP headers (`identity.user_id → X-User-ID`, `identity.tenant_id → X-Tenant-ID`, plus `product.*` sources) sent to your MCP server. |
| **Service auth** | Crow generates a **service key**; auto-injects it as `X-Service-Key` to your MCP server; you paste the same key into your backend `.env` and add a *second auth path* that, when the key validates, **trusts `X-User-ID` / `X-Tenant-ID` headers** for scoping. |
| **Client-side tools** | `window.crow('registerTools', {...})` registers browser handlers. Tool **JSON definitions are uploaded separately in the dashboard**. Handlers return `{status:'success'|'error', ...}`. `setToolStatus(msg)` shows a spinner line. |
| **Page navigation** | Routes (`name`, `path` with `:params`, description) are defined **in the dashboard**. Default execution is `window.location.href`; pass a `navigate` prop to use your SPA router. |
| **Tool renderers** | `toolRenderers={{ tool_name: Component }}` on `CrowCopilot`. Component receives `{ result: unknown, status }`. Rendered *below* the default status line, only on success. |
| **Workflows ("Journeys")** | A name, a trigger description, and an **ordered list of steps**; each step is prompt text plus an optional tool. That is the whole model. |
| **Event callbacks** | Client-side only: `onMessage`, `onMessageUpdate`, `onToolCall`, `onWorkflow`, `onVerificationStatus`, `onError`. `Message` carries an optional `thinking` field. |
| **Activity** | Conversation list with date/status/message-count/text filters; Chat, Details (id, duration, messages, tokens, cost), and a "Traces" tab described as raw debugging data. CSV/JSON export. |
| **Sandbox** | Agent name + system prompt + live preview. That's it. |
| **Envoy CLI** | `npx @usecrow/envoy` — an **LLM agent reads your codebase**, infers routes/schemas/auth, generates a **FastMCP** Python server, saves it to Crow with versioning; `fix` iterates conversationally; `deploy` ships it. **Crow hosts the generated server.** |
| **Multi-language, user suggestions, multi-subdomain endpoints** | Documented features (per-language response config, quick-action buttons, per-subdomain credentials). |

### 1.2 What Crow gets genuinely right

Worth stating plainly, because we should copy the *judgment*, not the code:

1. **Time to value is the product.** Script tag → live agent. Everything in their docs is subordinated to that.
2. **The four-noun mental model** (Knowledge, Actions, Identity, Activity) is legible in ten seconds. Most agent platforms cannot describe themselves that fast.
3. **JWT Forward** is the right instinct — per-user credentials rather than one god-key — even if the implementation stops short.
4. **Client-side tools + navigation as first-class primitives.** This is what separates "agent in your product" from "chatbot on your product," and they treat it that way.
5. **Envoy's insight is correct**: the bottleneck is not MCP, it's the tedium of wrapping an existing API. Attacking the tedium is right.
6. **Deterministic route resolution.** The docs are explicit that the SDK resolves a route *name* to a path — the model picks the name, not the URL. That is exactly the right division of labour, and it is the single best design decision in their docs.

### 1.3 Where Crow is structurally weak

These are the gaps that define our product. Each is a *design* limitation, not a missing checkbox.

**W1 — The service-key/trusted-header model is a confused deputy.**
Hop 3 of their auth chain instructs your backend to trust `X-User-ID` whenever `X-Service-Key` validates. The service key proves *"a trusted service is calling"*; it proves nothing about *which user*. Every party between the identity token and your database — Crow's backend, the generated MCP server, any intermediary — is now fully trusted to assert identity for any user in your tenant. A bug or compromise anywhere in that chain is a total cross-user authorization break, and your backend has no way to detect it. The identity JWT the user actually presented never reaches your API; only Crow's *assertion about it* does.

**W2 — Symmetric identity secrets.**
HS256 with a shared `CROW_VERIFICATION_SECRET` means the verifier can also mint. The same secret sits in your backend and in Crow's. There is no documented `aud`, `iss`, `jti`, or nonce, so a captured token is replayable until `exp` (recommended: one hour).

**W3 — No authorization layer at all.**
Tools are enabled per-*project*, not per-user, per-role, or per-resource. There is no documented risk classification, no approval step, no policy engine, no environment-specific policy. "Which of my users may cancel a subscription" has no answer in the product; it can only be answered inside your API, per endpoint, forever.

**W4 — Knowledge has no permission model and no versioning.**
Retrieval is a project-wide index. There is no documented way to say "these documents are visible to admins only." For a product whose pitch is *"the agent knows your product and acts on behalf of users,"* this is the largest single gap.

**W5 — Workflows are linear scripts.**
No conditions, no branching, no loops, no parallelism, no approval nodes, no typed state, no versions pinned to runs, no test mode with mocked tools. Any real journey ("cancel subscription, unless annual, unless in dunning, escalate if refund > ₹10,000") cannot be expressed.

**W6 — Configuration lives in a dashboard, and it drifts.**
Client tool *handlers* live in your code; their *schemas* are uploaded in the dashboard. Routes live in the dashboard while your router lives in code. Prompts, tool selection, and workflows are all dashboard state. Nothing is reviewable in a pull request, diffable, or promotable dev → staging → prod. This is also a correctness bug generator: the schema and the handler can disagree silently.

**W7 — Untyped extension points.** `toolRenderers` receives `result: unknown`; you hand-cast. Client tool args are unvalidated at the boundary.

**W8 — Observability is conversation-shaped, not run-shaped.** Filters are date/status/message-count. There is no per-tool success rate, no latency or cost breakdown by step, no failure taxonomy, no correlation ID into your own APM, no server-side webhooks — callbacks are browser-side only, so you cannot reliably act on `tool.failed` in your backend.

**W9 — No evaluation.** Nothing in the docs lets you assert "given this input, the agent must call `update_subscription(plan=pro)` and must never call `delete_customer`," or re-run that assertion when the prompt changes.

**W10 — No model choice, no self-hosting, no data residency.** The Sandbox exposes name + system prompt. No provider selection, no routing, no local models, no budget caps. Your users' conversations and your API credentials live in Crow's cloud, and your API is reachable from it.

**W11 — Envoy generates code you don't own.** An LLM reads your source, produces a Python MCP server, and Crow hosts and versions it. You cannot review the diff in git, you cannot run it in your VPC, and regeneration is non-deterministic. For an OpenAPI-described backend this is *strictly worse* than deterministic codegen.

**W12 — `thinking` is exposed on the message type.** Streaming raw model reasoning into a customer-facing widget is a data-leak and confusion surface.

---

## 2. The adjacent landscape (and why it changes our plan)

### 2.1 CopilotKit / AG-UI — the incumbent we must not ignore

This is the most important finding in this document.

<cite index="26-1">CopilotKit is an open-source framework and AG-UI protocol for building in-app AI copilots, agent UIs, and generative interfaces in React</cite>. <cite index="30-1">The AG-UI protocol standardizes how AI agents connect to and communicate with user interfaces, providing streaming chat, front-end tool calls, and state sharing to enable human-in-the-loop functionality</cite>, and <cite index="30-1">is supported by Google, Microsoft, Amazon and Oracle, as well as LangChain, Mastra, PydanticAI and Agno</cite>. <cite index="30-1">CopilotKit raised a $27M Series A led by Glilot Capital, NFX and SignalFire</cite>, with <cite index="32-1">an MIT-licensed React/Angular codebase at roughly 34.7K GitHub stars</cite>.

Technically, AG-UI is <cite index="41-1">an open, lightweight, event-based protocol with roughly 16 standard event types that works with any transport (SSE, WebSockets, webhooks)</cite>. Three of its features map exactly onto requirements in our brief:

- <cite index="34-1">**Activity events** manage frontend-only structured UI such as progress bars and search statuses that are *not sent back to the LLM*</cite> — this is precisely the "show real execution states, not `Thinking…`, without exposing chain-of-thought" requirement.
- <cite index="38-1">**INTERRUPT** pauses agent execution to request human approval, acting as a safety valve for sensitive actions</cite> — our approval model has a standard wire representation.
- <cite index="35-1">**STATE_DELTA** carries incremental state updates using JSON Patch (RFC 6902)</cite> — page-aware context sync without bespoke plumbing.

**Consequence for our design:** inventing a proprietary frontend↔agent wire protocol would be the single worst decision available to us. We would be building a worse version of a protocol that four hyperscalers already implement, and we would lock ourselves out of every AG-UI-compatible frontend and backend. **We adopt AG-UI as our transport and differentiate above and below it.**

And there is a clean opening. One review notes plainly that <cite index="32-1">CopilotKit helps build the user-facing agent experience, but teams still need model providers, backend tools, permissions, and production safety design</cite>. That sentence is our product spec. CopilotKit is a **frontend/protocol layer**. Crow is a **hosted vertical product**. Nobody is shipping the open-source **governed control plane** in between: identity → authorization → policy → tool execution → permissioned knowledge → traces → evals.

### 2.2 MCP — a moving target we must target correctly

<cite index="54-1">The 2026-07-28 MCP specification shipped as final on 28 July 2026, bringing a stateless protocol core, Multi Round-Trip Requests, header-based routing, cacheable list results, authorization hardening, and a formal extensions framework</cite>. <cite index="55-1">The headline change is removal of the initialize/initialized handshake and the `Mcp-Session-Id` header</cite>. <cite index="60-1">Multi Round-Trip Requests (SEP-2322) replace server-initiated calls like sampling and elicitation: a server returns an `InputRequiredResult` carrying `inputRequests` plus an opaque `requestState`, and the client re-issues the original call with `inputResponses`</cite>. <cite index="52-1">Server-initiated requests may now only be issued while the server is actively processing a client request, so a user is never prompted out of nowhere and every elicitation traces back to something they started</cite>. <cite index="57-1">Roots, Sampling and Logging are deprecated in this revision, with implementations advised to use tool parameters, direct provider APIs, and stderr or OpenTelemetry instead</cite>.

Two implications:
1. **Target 2026-07-28 with a 2025-11-25 compatibility path.** Crow's docs still describe a session/transport model from the previous era.
2. **MRTR is our approval channel over MCP.** `InputRequiredResult` → our Approval Manager → AG-UI `INTERRUPT` → user decision → re-issued call with `inputResponses`. One coherent human-in-the-loop path from MCP server to browser, no bespoke glue.

### 2.3 OpenAI AgentKit — a cautionary tale, cited in our README

<cite index="49-1">On 3 June 2026 OpenAI deprecated Agent Builder (the visual workflow canvas) and the Evals platform; both leave the platform on 30 November 2026, with Evals going read-only on 31 October 2026. ChatKit, the embeddable chat UI, remains available.</cite> <cite index="44-1">OpenAI recommends the Agents SDK for workflows that should continue as code.</cite> The lesson, as one write-up puts it: <cite index="49-1">a hosted visual builder is a proprietary surface a vendor can sunset on its own schedule — but tool integrations that speak MCP port to any runtime</cite>.

This is the empirical argument for our config-as-code + open-format position, and it happened three months ago to the largest vendor in the space. It belongs in our positioning, stated factually.

### 2.4 Agent frameworks — what we build *on*, not against

<cite index="62-1">LangGraph leads enterprise adoption (~34.5M monthly downloads) and Dify leads GitHub stars (~144k); teams needing human-in-the-loop approval should look at LangGraph, which has the most mature suspend/resume support, and Mastra offers native OpenTelemetry</cite>. <cite index="68-1">Mastra combines four-tier memory, first-class MCP, `.suspend()`/`.resume()` for human-in-the-loop and built-in evals in one TypeScript package</cite>. <cite index="61-1">Dify is a full LLM application platform — visual workflow editor, RAG pipeline, agent capabilities and 100+ model providers in one self-hosted stack</cite>.

None of these is an *in-app SaaS agent layer*. They are orchestration libraries and general LLM-app platforms. They lack: end-user identity binding, per-end-user authorization, client-side tool execution in the customer's app, and permissioned knowledge scoped to the asking user. We should be **composable with them** (an AG-UI-compatible backend can be a LangGraph or Mastra agent) rather than competing on orchestration primitives.

### 2.5 Prompt-injection defense — the research we build on

The state of the art has moved from "prompt the model harder" to "enforce policy outside the model," and we should implement that rather than re-derive it. <cite index="73-1">Recent work from 2024–2026 has converged on enforcing security outside the model with a deterministic policy mediating the agent's actions; systems such as CaMeL, FIDES, Progent, RTBAS and FORGE realize this with capabilities, information-flow labels and reference monitors, several reporting near-elimination of attacks on the AgentDojo benchmark</cite>. <cite index="69-1">The core insight of the dual-LLM pattern, operationalized by CaMeL, is to separate the LLM that controls actions from the LLM that processes untrusted content</cite>, and <cite index="78-1">a custom interpreter tracks data provenance and enforces security policies before each tool call</cite>. Microsoft's FIDES <cite index="69-1">enforces two invariants deterministically: tool calls must be based on trusted-integrity data, and data may only flow to recipients permitted to read it</cite>.

The honest framing, which our docs will repeat: <cite index="69-1">prompt injection cannot be fully solved within current LLM architectures, and any defense expressed as a prompt instruction can itself be overridden</cite>. What is achievable is <cite index="69-1">defense in depth: track content provenance and structurally separate untrusted data from instructions, reduce capability scope, enforce deterministic policy outside the LLM, and constrain egress so exfiltration is blocked even when injection succeeds</cite>.

---

## 3. Feature matrix

Legend: ● full · ◐ partial · ○ absent. "Advantage" states the *engineering* reason, or says there isn't one.

### 3.1 Embedding & SDKs

| Capability | Crow | Ours | Advantage — or none |
|---|:--:|:--:|---|
| Embeddable widget | ● | ● | None. Parity feature. |
| Script tag | ● | ● | None. |
| React SDK | ● | ● | Ours is typed end-to-end: tool schemas are the source of truth for handler args *and* renderer props, so schema/handler drift is a compile error rather than a runtime cast. |
| Vue / vanilla / Next.js | ◐ | ● | Consequence of speaking AG-UI rather than a private protocol — any AG-UI client works, so new SDKs need no backend change. |
| React Native / Flutter | ● | ○ (Phase 3) | **Crow is ahead.** They ship both today; we will not for a year. |
| Wire protocol | private | **AG-UI** | Interop with an ecosystem four hyperscalers implement; our backend can drive their frontends and vice versa. Also a hedge: if we fail, users keep their frontend. |
| Custom tool renderers | ● (`result: unknown`) | ● (typed from output schema) | Type safety at the one boundary most likely to break silently after a backend change. |
| Headless / server-side use | ○ | ● | Same runtime, no widget — required for batch, cron, and webhook-triggered agents. |

### 3.2 Knowledge

| Capability | Crow | Ours | Advantage — or none |
|---|:--:|:--:|---|
| Files (PDF/DOCX/MD/CSV/HTML) | ● | ● | None. |
| Website / sitemap crawl | ● | ● | None, except crawl history and diffing. |
| Notion | ● | ● (connector) | None; ours is one connector on a documented interface rather than a built-in. |
| Hybrid retrieval (BM25 + vector + metadata + rerank) | *unverified* | ● | Keyword recall for identifiers (SKUs, error codes, plan names) that embeddings reliably miss; RRF fusion; pluggable reranker. |
| **Per-document permissions enforced pre-retrieval** | ○ | ● | **The single most important knowledge difference.** ACL is a predicate inside the retrieval SQL, not a post-filter — post-filtering leaks existence through counts, scores and pagination. Security happens before context reaches the model. |
| Document versioning + content hashing | ○ | ● | Answers "why did the agent say that in March?" and prevents stale-chunk answers after a re-crawl. |
| Knowledge snapshot pinned to a run | ○ | ● | Reproducibility of historical runs. |
| Retrieval playground (query → candidates → scores → rerank → final context) | ○ | ● | RAG debugging is otherwise guesswork; this converts it into inspection. |

### 3.3 Tools & integration

| Capability | Crow | Ours | Advantage — or none |
|---|:--:|:--:|---|
| OpenAPI → tools, per-operation opt-in | ● | ● | Ours is deterministic codegen committed to *your* repo; an LLM may draft descriptions offline, reviewed in a PR, never at runtime. |
| External MCP servers | ● | ● | Ours targets MCP 2026-07-28 (stateless, MRTR) with 2025-11-25 fallback. |
| Your own MCP server | ● | ● | None. |
| MCP generation CLI | ● (Envoy, LLM-read, Crow-hosted) | ● (`keel generate`, deterministic, in-repo) | Output is a reviewable diff you own and host. Deterministic from OpenAPI; regeneration is idempotent. Nothing uploads your source by default. |
| Client-side tools | ● | ● | Schema and handler declared together in code; the CLI syncs them. Removes an entire class of drift bug. |
| Server tools / code tools | ◐ | ● | Typed contracts with timeouts, retry class, idempotency and cache policy per tool. |
| Page navigation | ● (dashboard routes) | ● (routes as code) | Same correct instinct — model chooses a route *name*, never a URL — but the route table lives next to the router, so it can't drift. |
| **Tool risk levels** | ○ | ● | `read / write / high / destructive / critical` drives approval policy, retry safety and idempotency requirements automatically instead of per-endpoint hand-wiring. |
| **Human approval as a runtime state** | ○ | ● | Durable pause/resume; approvals survive page reload and process restart; expressed on the wire as AG-UI `INTERRUPT` and MCP `InputRequiredResult`. |
| Idempotency keys on mutations | ○ | ● | Agents retry. Without this, retries double-charge. |
| Tool caching (per-tool policy) | ○ | ● | Read tools cache; mutations never do; policy is declared, not inferred. |
| Deterministic execution paths | ◐ (navigation only) | ● | Known route, known transform, known validation run as code. Cheaper, faster, reproducible, testable. |

### 3.4 Identity, authorization, security

| Capability | Crow | Ours | Advantage — or none |
|---|:--:|:--:|---|
| End-user identity | ● (HS256 shared secret) | ● (asymmetric, JWKS, `aud`/`jti`/short TTL) | Verifier can no longer mint. Replay is bounded by `jti` + 60s action tokens. |
| Identity claims → tools | ● (headers, trusted) | ● (**action tokens**) | Your backend verifies a token chained to the user's own identity token and bound to `(tool, args_hash, run_id)`. A compromised control plane cannot assert "this is user 42." Removes the confused-deputy hole in W1. |
| Per-user / per-role tool permissions | ○ | ● | Authorization is a first-class layer, not something re-implemented in every endpoint. |
| Policy engine (user/role/org/resource/risk/env) | ○ | ● | Policy is data, versioned in git, testable in CI, evaluated before any tool call. |
| **Provenance / taint tracking** | ○ | ● | Values derived from untrusted sources (web pages, uploaded docs, third-party MCP output) carry integrity labels; the policy engine refuses to let tainted data drive a mutating tool call without approval. This is the CaMeL/FIDES invariant, enforced deterministically outside the model. |
| Egress control / SSRF defense | *unverified* | ● | Outbound allowlist, DNS-pinned resolution, link-local and metadata ranges denied, redirects re-validated. |
| Multi-tenancy isolation | ● | ● | Ours adds Postgres RLS as defense in depth beneath application-level scoping. |
| Audit log | *unverified* | ● | Append-only, hash-chained, covering every approval and every risk ≥ high tool call. |
| Secrets | ● (dashboard) | ● (pluggable provider) | Env / file / Vault / cloud KMS; never rendered into model context; redacted in traces by default. |
| Self-hosting | ○ | ● | Your users' conversations and your API credentials stay in your infrastructure. For regulated buyers this is not a preference, it is the gate. |

### 3.5 Workflows

| Capability | Crow | Ours | Advantage — or none |
|---|:--:|:--:|---|
| Guided multi-step flows | ● (linear) | ● (typed DAG) | Real journeys need conditions. Linear scripts cannot express "unless annual plan." |
| Branching / switch | ○ | ● | — |
| Loops with explicit bounds | ○ | ● | Bounded by construction; infinite loops are unrepresentable, not merely discouraged. |
| Parallel branches with concurrency cap | ○ | ● | Independent reads run concurrently; mutations respect declared dependencies. |
| Approval nodes | ○ | ● | — |
| Versioning, runs pinned to a version | ○ | ● | Editing a live workflow cannot change in-flight runs. Debugging a two-week-old run is possible. |
| Test run with mocked tool results | ○ | ● | Test agent behaviour without touching production data. |
| Export / import (JSON, git-reviewable) | ○ | ● | The exported file *is* the stored artifact; no lossy round trip. |
| Visual builder | ○ (form) | ● (Phase 2, XYFlow) | Deliberately Phase 2 — the engine must be right before the canvas. |

### 3.6 Runtime, models, operations

| Capability | Crow | Ours | Advantage — or none |
|---|:--:|:--:|---|
| Model choice | ○ | ● | Anthropic / OpenAI / Google / Azure / any OpenAI-compatible / Ollama / vLLM behind one interface. |
| Model routing by task class | ○ | ● | Cheap model for classification and tool selection, strong model for planning. Measurable cost and latency reduction; policy is configurable and every routing decision is recorded. |
| Cost / token / call budgets | ◐ (cost shown) | ● | Enforced ceilings per run, agent, project and org — stop safely, don't just report after the fact. |
| Rate limits (user/project/agent/tool/IP) | *unverified* | ● | — |
| Cancellation propagated to workers | ○ | ● | A Stop button that actually stops the tool call, not just the stream. |
| Structured failure recovery | ○ | ● | Typed error taxonomy → per-class strategy. Never blind-retry a destructive call. |
| Model failover | ○ | ● (opt-in, recorded) | Off by default: silent model substitution changes behaviour. |
| Server-side webhooks (signed, retried, idempotent) | ○ | ● | Crow's callbacks are browser-side only — you cannot reliably react to `tool.failed` in your backend. |
| Live event stream | ● (SSE) | ● (SSE, AG-UI) | None. |

### 3.7 Observability & evaluation

| Capability | Crow | Ours | Advantage — or none |
|---|:--:|:--:|---|
| Conversation viewer | ● | ● | None. |
| Structured execution trace | ◐ ("raw debugging data") | ● | Typed `run_step` records: context assembled, retrieval performed, policy decision, tool call, result, verification, recovery. Inspectable, filterable, and explicitly **not** chain-of-thought. |
| OpenTelemetry, correlation into your APM | ○ | ● | The run appears in *your* Grafana/Datadog next to the API calls it caused. |
| Per-tool success rate, latency, cost | ○ | ● | The metric that actually predicts user trust. |
| Failure taxonomy dashboards | ○ | ● | "Top failing tools" and "top unanswered intents" are the two screens that drive the improvement loop. |
| **Evaluation datasets with trajectory assertions** | ○ | ● | Assert the *tool call and arguments*, plus forbidden tools and policy expectations — not just final text similarity. |
| **CI regression gate** | ○ | ● | Prompt, model, or tool change → replay suite → diff vs. baseline → block the merge. This is the difference between an agent product and an agent demo. |
| Tool contract tests | ○ | ● | Schema, auth, timeout, retry and failure behaviour tested per tool, independent of the model. |
| Feedback tied to agent version + tool calls | ◐ | ● | Feedback becomes eval cases instead of a dashboard number. |

### 3.8 Where Crow is genuinely ahead, and will stay ahead for a while

Stated so the matrix isn't self-congratulatory:

- **Shipping product with real customers.** We have zero.
- **Mobile SDKs** (React Native, Flutter) exist today.
- **Time to first value.** A hosted service will always beat `docker compose up` for a developer evaluating on a Tuesday afternoon. We must close this with a hosted sandbox and a one-command demo, and we will still lose some of it.
- **Focus.** Two people shipping one opinionated path will out-iterate a broad architecture. Our answer is staged scope, not more surface area.
- **Envoy's zero-effort onboarding.** For a backend with no OpenAPI spec, "point an LLM at the repo" genuinely beats "write a spec first." We need a credible answer for spec-less backends.

---

## 4. Selected differentiators

Seven, ranked by defensibility. Ordering matters more than the list — these are the ones a buyer would switch for.

1. **Proof-carrying authorization (action tokens + policy engine).** Fixes Crow's confused-deputy model *and* gives per-user, per-role, per-resource, risk-tiered tool permissions with durable human approval. This is the enterprise blocker for every hosted competitor.
2. **Permissioned, versioned knowledge.** ACLs enforced inside the retrieval query; documents versioned and snapshot-pinned to runs. Nobody in this segment does this.
3. **Provenance-aware execution (CaMeL/FIDES-style).** Deterministic, testable injection resistance rather than a prompt that says "ignore malicious instructions."
4. **Evaluation and CI regression gating on trajectories.** Turns "we changed the prompt and hoped" into a merge gate. OpenAI just deprecated their hosted Evals product; the need did not go away.
5. **Config as code with plan/apply.** Agents, tools, routes, policies and workflows in git, promoted dev → staging → prod, diffable in review. Directly targets Crow's W6 drift problem and the AgentKit sunset lesson.
6. **Genuine self-hosting with model freedom.** `docker compose up`, any provider, local models, no phone-home. This is the whole reason a regulated buyer will look at us.
7. **Real observability.** OpenTelemetry-native structured traces correlated with the customer's own APM, per-tool reliability metrics, signed server-side webhooks.

Deliberately **not** claimed as differentiators: "more nodes," "more integrations," "prettier UI," and — importantly — "better agent quality." Agent quality comes from the model plus the tool contracts; we should claim *control and reliability*, which we can actually deliver, not intelligence, which we cannot.
