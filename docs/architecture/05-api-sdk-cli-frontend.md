# 05 — API, SDK, CLI, Frontend, Design System

## Part A — REST API

Versioned under `/api/v1`. Three audiences, three auth modes, and they must not blur:

| Surface | Caller | Auth |
|---|---|---|
| `/api/v1/*` | Control plane (dashboard, CI, backend SDKs) | API key or dashboard session |
| `/rt/v1/*` | Embedded widget | End-user identity token → session |
| `/mcp` | External MCP clients | OAuth 2.1 |

Cross-cutting: cursor pagination (`?cursor=&limit=`), `Idempotency-Key` on every mutating POST, RFC 9457 problem details for errors (carrying our `error_class`), `X-Request-Id` echoed and threaded into traces.

```http
# Projects, agents, versions
POST   /api/v1/projects
GET    /api/v1/projects/{id}
POST   /api/v1/projects/{id}/agents
POST   /api/v1/agents/{id}/versions            # publish (immutable)
POST   /api/v1/agents/{id}/promote             # {version, environment}

# Conversations and runs
POST   /rt/v1/sessions                         # identity token -> session
POST   /rt/v1/conversations
POST   /rt/v1/conversations/{id}/runs          # -> AG-UI event stream (SSE)
POST   /rt/v1/runs/{id}/cancel
POST   /rt/v1/runs/{id}/tool-results           # client tool results
POST   /rt/v1/approvals/{id}/decide
GET    /api/v1/runs/{id}                       # run + steps (trace)
POST   /api/v1/runs/{id}/replay                # deterministic replay, dev/staging only

# Headless
POST   /api/v1/agents/{id}/runs                # {input, identity_token?, stream?}

# Tools
GET    /api/v1/projects/{id}/tools
POST   /api/v1/projects/{id}/tools/sync        # {contracts[]} from CLI, returns a plan
POST   /api/v1/tools/{id}/versions
POST   /api/v1/tools/{id}/invoke               # playground; policy still applies
POST   /api/v1/projects/{id}/openapi/import    # {spec} -> proposed contracts (no side effects)
POST   /api/v1/projects/{id}/mcp-servers

# Knowledge
POST   /api/v1/projects/{id}/knowledge/sources
POST   /api/v1/knowledge/sources/{id}/sync
GET    /api/v1/knowledge/sources/{id}/documents
POST   /api/v1/projects/{id}/knowledge/query   # retrieval playground; ?as_principal= (dev only)
POST   /api/v1/projects/{id}/knowledge/snapshots

# Workflows, policy, evaluation
POST   /api/v1/projects/{id}/workflows
POST   /api/v1/workflows/{id}/versions
POST   /api/v1/workflows/{id}/runs
POST   /api/v1/workflow-versions/{id}/test     # mocked tools
POST   /api/v1/projects/{id}/policy/versions
POST   /api/v1/projects/{id}/policy/explain    # {tool, principal, args} -> decision + rule id
POST   /api/v1/projects/{id}/evaluations
POST   /api/v1/evaluations/{id}/runs           # {agent_version_id, baseline?}
GET    /api/v1/evaluation-runs/{id}/diff       # vs baseline

# Activity
GET    /api/v1/projects/{id}/events            # SSE
POST   /api/v1/projects/{id}/webhooks
GET    /api/v1/projects/{id}/audit-logs

# Config as code
POST   /api/v1/projects/{id}/config/plan       # dry run -> diff
POST   /api/v1/projects/{id}/config/apply      # {plan_id} -> applied changes
```

`plan` / `apply` is Terraform's contract and it is the right one: the CLI shows exactly what will change before anything changes, and `apply` is idempotent against a plan id.

## Part B — SDKs

**Three packages, small surface, no internals exposed.**

`@keel/react` — provider, `<Assistant>`, `<AssistantPanel>`, `defineClientTool`, `defineRoutes`, `useKeel()`, `useKeelEvents()`, renderer registration. Headless hooks are the real API; the components are a default UI built on them, so anyone can replace the UI without leaving the SDK.

`@keel/client` — framework-free core: AG-UI transport, session and identity refresh, tool dispatch, event emitter, cancellation. Every other frontend SDK (Vue, Svelte, vanilla, React Native) is a thin binding over this.

`@keel/node` / `keel` (Python) — server-side: run agents headlessly, manage config, mint nothing (identity minting stays in customer code with our small `keel-identity` helper). The Python SDK is **generated from the OpenAPI spec** plus a hand-written ergonomic layer — not a second implementation that drifts.

```python
from keel import Keel
client = Keel(base_url=..., api_key=...)

run = client.agents.run(
    agent="support",
    input="Cancel subscription for customer 8812",
    identity_token=mint_identity(user),      # required for user-scoped tools
    on_approval=lambda a: notify_slack(a),
)
for event in run.stream():
    if event.type == "tool.completed":
        log(event.tool, event.latency_ms)
```

Typed events, typed errors matching the taxonomy, `AbortSignal`/`asyncio.CancelledError` respected end to end.

## Part C — CLI

```bash
keel init                    # scaffold keel.yaml, keys, .env.example, tool dir
keel dev                     # local runtime + tunnel; hot-reloads tools and policy
keel tools sync              # push contracts from code; --dry-run prints the diff
keel tools test <name>       # contract tests: schema, auth, timeout, failure modes
keel generate openapi        # spec -> keel/tools/*.yaml (deterministic, opt-in per operation)
keel generate mcp            # tools -> an MCP server IN YOUR REPO
keel generate types          # tool contracts -> TS types + Python models
keel knowledge sync|status|query
keel policy test|explain|lint
keel workflow validate|test|diff
keel eval run --dataset support --baseline main   # exits non-zero on regression
keel logs --run <id> --follow
keel plan | keel apply       # config as code, dev -> staging -> production
keel doctor                  # 20+ checks: identity, JWKS reachability, drift, orphan tools,
                             # ambient-write bindings, missing timeouts, oversized context,
                             # untested tools, policy default-allow, unpinned versions
```

`keel doctor` is the highest-leverage command and should be built early. It is where accumulated production knowledge lives, and it is what makes a self-hosted product feel supported. Every incident we hit becomes a check.

**On the Envoy comparison:** `keel generate mcp` writes a server into the user's repository, committed and reviewed, running in their infrastructure. Deterministic from OpenAPI. Optional `--from-source` for spec-less backends prints exactly which files it will read, supports `--local-model` so nothing leaves the machine, and produces an **OpenAPI spec** as its artifact — a reviewable, portable, standard file — rather than a hosted black box.

## Part D — Frontend Architecture

**Stack**, with the reasoning:

| Choice | Why | Alternative rejected |
|---|---|---|
| React 19 + TypeScript strict | Non-negotiable for SDK reach | — |
| **Vite + React Router** for the dashboard | It's an authenticated SPA; SSR buys nothing and Next.js adds a server we'd have to operate in every self-host | Next.js — keep for the docs/marketing site only |
| TanStack Query | Server state is 90% of this app | Redux/RTK — too much ceremony |
| Zustand, sparingly | Only genuinely global client state: command palette, filters, theme | Context everywhere — re-render cost |
| Tailwind + Radix primitives | Radix gives real accessibility; Tailwind gives token discipline | Component libraries — you inherit someone else's visual language |
| XYFlow | Workflow canvas, Phase 2 | Hand-rolled SVG — weeks, worse a11y |
| ECharts | Dense time-series, good perf, no React wrapper churn | Recharts is fine but weaker at high cardinality |

```
apps/dashboard/src/
  app/            routes, layouts, providers, error boundaries
  features/       agents/ tools/ knowledge/ workflows/ activity/ evaluation/ settings/
                    ├── api/        query + mutation hooks (the ONLY place fetch lives)
                    ├── components/ feature-specific
                    ├── hooks/
                    └── types.ts
  components/     design-system primitives (feature-agnostic)
  lib/            formatting, dates, permissions, keyboard
```

Rules: no `fetch` outside `features/*/api`; no business logic in components; every list has real loading, empty, error and permission-denied states (empty states are designed, not `No data`); every route is code-split; every interactive element is reachable by keyboard.

## Part E — Design System

The brief's hard requirement is that this must not look vibe-coded. That is achievable with a small number of enforced constraints, and it is mostly about *restraint*.

### E1. Principles

1. **Borders, not shadows.** Hierarchy comes from 1px borders and background steps. Elevation is reserved for genuinely floating surfaces (popover, dialog, toast) and uses one shadow token.
2. **Density is a feature.** Default row height 32px, compact mode 28px. This is a tool operators live in.
3. **Two type families.** UI sans (Inter or system stack) and mono (JetBrains Mono / ui-monospace). **Every identifier, id, tool name, JSON value and duration is mono** — it makes them scannable and selectable, and it does more for the "serious tool" feeling than any other single decision.
4. **One accent.** Blue for interaction. Semantic colours only for state (success/warning/danger/info). No gradient, ever, anywhere.
5. **Motion communicates state.** 120–180ms, `ease-out`. Entry/exit, expand/collapse, streaming indicators. No decorative animation. `prefers-reduced-motion` removes all of it.
6. **Explicit focus.** 2px ring, 2px offset, on everything focusable. Never `outline: none`.

### E2. Tokens

```css
--font-sans: Inter, system-ui, sans-serif;
--font-mono: "JetBrains Mono", ui-monospace, monospace;
/* 12 13 14 16 20 24 32 — seven sizes, no more */
--space: 4px base;  /* 4 8 12 16 24 32 48 64 */
--radius-sm: 4px; --radius-md: 6px; --radius-lg: 8px;   /* never larger */
--border: 1px solid var(--border-default);
--shadow-overlay: 0 8px 24px -4px rgb(0 0 0 / 0.12);    /* the only shadow */
--duration-fast: 120ms; --duration-base: 180ms;
```

Dark mode is the default (this is a developer tool people stare at) with a proper light theme, both driven by the same semantic tokens (`--bg-surface`, `--text-secondary`, `--border-strong`). All colour pairs meet WCAG AA; the CI runs a contrast check over the token matrix so a theme tweak can't silently break it.

### E3. Primitives

`Button` `IconButton` `Input` `Textarea` `Select` `Combobox` `Checkbox` `Radio` `Switch` `Dialog` `Drawer` `Popover` `DropdownMenu` `Tooltip` `Tabs` `Table` (virtualised) `DataGrid` `Badge` `StatusDot` `Toast` `Sidebar` `CommandPalette` `Breadcrumb` `EmptyState` `Skeleton` `CodeBlock` `JSONViewer` `DiffViewer` `Timeline` `KeyValue` `Duration` `CostTag` `TokenTag`.

Domain composites, built only from primitives: `ToolCard` `ApprovalCard` `ExecutionStep` `TracePanel` `RetrievalResult` `PolicyDecision` `WorkflowNode` `EvalDiffRow`.

### E4. Explicitly banned

Gradients. Glassmorphism. Purple/violet "AI" glow. Border radius > 8px on containers. Multiple shadow levels. Emoji as UI icons. Hero numbers larger than 32px. Decorative illustration. Animated backgrounds. Any component whose only job is to look impressive in a screenshot.

### E5. Screens that carry the product

- **Run detail** — the most important screen. Left: step timeline (each step showing type, duration, cost, status). Right: selected step detail (inputs, outputs, policy decision + rule id, retrieval scores, error class). Header: agent version, model, tool versions, knowledge snapshot, total cost, total latency. This screen answers "why did it do that?" and it is the screen that convinces an engineer we are serious.
- **Retrieval playground** — query → per-retriever candidates with scores → fusion → rerank → final context, with ACL exclusions shown as counts.
- **Evaluation diff** — baseline vs candidate, per-case pass/fail with the specific failing assertion, aggregate deltas for success rate, tool accuracy, latency, cost.
- **Policy explain** — principal + tool + args in, decision + matched rule out.

### E6. Embedded widget

Different constraints from the dashboard: it lives inside someone else's product and must be unobtrusive, fast, and themeable.

- **Shadow DOM** for style isolation. Non-negotiable — the widget must not be broken by, or break, the host's CSS.
- Theme via CSS custom properties the host sets; sensible defaults that read as neutral rather than as "an AI product bolted on."
- **Status, not spinners.** `ACTIVITY` events render as `Searching customers…` → `✓ Found 43`. Never `Thinking…`. Never streamed model reasoning.
- **Action affordances are visually distinct by risk.** Information is prose; an action shows a bordered card; a destructive action shows an emphasised card with the consequence stated; an approval shows an explicit approve/reject affordance. Mutations never hide inside a conversational sentence.
- **Stop is always available** while a run is active, and it actually cancels the tool call.
- A11y: full keyboard operation, focus trap in the panel with escape restoration, ARIA live region for streaming with polite announcements (not per-token), screen-reader-friendly tool status, reduced-motion respected.
- i18n from day one: no user-visible string literal in a component. UI locale and agent response language are configured separately — the interface can be English while the agent replies in Tamil.
- Budget: **< 45 KB gzipped** for `@keel/client` + widget core, renderers lazily loaded. Enforced by a size check in CI, because widget weight is a tax on the customer's Core Web Vitals and it is the first thing a serious frontend team will measure.
