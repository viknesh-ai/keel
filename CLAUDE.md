# CLAUDE.md

Project context for Claude Code. Read this before any task in this repo.

## What this is

**Keel** — an open-source, self-hostable control plane that lets an existing SaaS application safely delegate work to an AI agent on behalf of an authenticated end user.

Not a chat widget. Not an agent orchestration framework. The governed layer between them: identity → authorization → policy → tool execution → permissioned knowledge → traces → evaluation.

## Authoritative design docs

Read the relevant one **before** writing code in that area. They are the spec; this file is the summary.

```
docs/research/competitive-analysis.md          why we're building this, what exists
docs/architecture/01-thesis-system-and-runtime.md   runtime, lifecycle, model layer, errors
docs/architecture/02-tools-openapi-mcp-client.md    tool contract, OpenAPI, MCP, client tools
docs/architecture/03-knowledge-identity-policy.md   retrieval, ACLs, identity, policy engine
docs/architecture/04-workflows-and-data-model.md    workflow graph, DB schema
docs/architecture/05-api-sdk-cli-frontend.md        REST API, SDKs, CLI, frontend, design system
docs/architecture/06-observability-and-evaluation.md  OTel, events, evals
docs/security/threat-model.md                       threats and required controls
docs/ROADMAP.md                                     slices, tech decisions, build order
docs/adr/                                           architecture decision records
```

If a task contradicts a doc, **stop and say so**. Do not silently deviate. If the doc is wrong, update it in the same PR.

## Stack

TypeScript strict everywhere · Node 22 · pnpm workspaces + Turborepo · Postgres 16 + pgvector · Redis · Vite + React 19 (dashboard) · Tailwind + Radix · Zod → JSON Schema · Vitest + Playwright · Biome · OpenTelemetry · AG-UI wire protocol · MCP 2026-07-28.

## Layout and dependency direction

```
packages/*   pure, no HTTP, no DB driver — ports only. NEVER import from services/*.
services/*   api (HTTP surface, zero business logic) and worker.
apps/*       dashboard, demo-saas, vulnerable-demo, docs.
packages/contracts imports nothing. Everything else may import it.
```

## Hard rules

1. **No `any`.** No `@ts-ignore`. Strict mode stays on.
2. **No bare `catch (e)`.** Every error is a member of the taxonomy in `packages/contracts/src/errors.ts`. Narrow before handling.
3. **Every tenant query filters `org_id`.** RLS is defence in depth, not the primary control.
4. **Secrets are `secret_ref` strings.** Never a plaintext value in a type, a log, a trace, or model context.
5. **Never trust a client-supplied user id.** Identity comes only from a verified signed token.
6. **Default-deny.** New tools, new MCP tools, new OpenAPI operations are all disabled until explicitly enabled.
7. **Every external call has a timeout.** No unbounded fetch, ever.
8. **Version rows are insert-only.** `agent_versions`, `tool_versions`, `workflow_versions`, `policy_versions`, `document_versions` are never UPDATEd.
9. **`run_steps` is append-only.** Corrections are new steps.
10. **No chain-of-thought reaches the user.** Expose typed execution events only.

## Style

- Small files. If a file passes ~300 lines, it's doing two jobs.
- Small components. Business logic lives in hooks and `features/*/api`, never in JSX.
- No comments explaining *what* the code does. Comments explain *why*, and only when it isn't obvious.
- No speculative abstraction. Two call sites before an interface, unless it's a declared port.
- Named exports. No default exports except React route components.
- Errors are values in the domain layer; exceptions only at boundaries.

## Never do

- Stub a feature and present it as working. If it isn't built, say so and leave it out.
- Add a dependency without saying why in the PR description.
- Generate placeholder/fake data outside `apps/demo-saas` seeds and test fixtures.
- Write a TODO instead of finishing the task. Raise the blocker instead.
- Reformat or refactor files the task didn't ask about.

## Commands

```bash
pnpm dev            # full stack
pnpm test           # unit
pnpm test:int       # integration (needs compose up)
pnpm test:e2e       # Playwright
pnpm test:security  # attack corpus
pnpm typecheck
pnpm lint
pnpm migrate
docker compose up
```

## Definition of done (every session)

- [ ] `pnpm typecheck && pnpm lint && pnpm test` green
- [ ] New behaviour has tests, including one failure-path test
- [ ] No new `any`, no new TODO, no stubbed function
- [ ] Docs updated if the design changed
- [ ] The session's stated exit criterion is demonstrably met — show the command and its output

## How to work

Plan before writing. State the plan, list the files you'll create or change, and wait for confirmation. Then implement one coherent unit, run the checks, and report what you did and what you deliberately left out.

If you're uncertain about a design decision, ask. Guessing costs more than the question.
