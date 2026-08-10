# Keel

**The open-source control plane that lets an existing application safely delegate work to an AI agent on behalf of an authenticated user.**

Not a chat widget. Not an agent orchestration framework. The governed layer in between:
identity → authorization → policy → tool execution → permissioned knowledge → traces → evaluation.

---

## Status

**Pre-alpha scaffold.** The architecture is designed and documented; the implementation has not started.

What exists today:

- Complete architecture, security and roadmap documentation under `docs/`
- Monorepo skeleton with tooling, CI, and enforced dependency boundaries
- A local infrastructure stack (`docker compose up`)

What does not exist yet: everything else. Nothing in `packages/` or `services/` is implemented.
See `docs/build/session-prompts.md` for the build order.

This README will make product claims when the product can back them. Until then it describes
what is here.

---

## Why this exists

Adding an AI agent to an existing SaaS product is mostly not an AI problem. It is an
authorization problem, a knowledge-permissions problem, an observability problem, and a
"prove it still works after you changed the prompt" problem.

The existing options split badly. Frontend frameworks give you the chat surface and leave
permissions, tool contracts and production safety to you. Hosted products give you all of it
in exchange for your users' conversations and your API credentials living in someone else's
cloud, with an authorization model that often reduces to "trust this header."

Keel is the part in between, self-hosted, with the security properties written down and tested.

Read `docs/research/competitive-analysis.md` for the full landscape and an honest account of
where existing products are ahead of this one.

---

## Design principles

1. **A client-supplied user id is not an identity.** Identity is a token signed by your key.
2. **Default-deny.** New tools, MCP tools and OpenAPI operations are disabled until enabled.
3. **Authorization is a layer, not per-endpoint code.** Policy is data, versioned in git, testable in CI.
4. **Untrusted content never becomes an instruction.** Provenance is tracked and enforced outside the model.
5. **Determinism where reasoning isn't required.** Routes, validation, permissions and transforms are code.
6. **Every run is reproducible.** Runs pin agent, tool, policy and knowledge versions.
7. **No chain-of-thought reaches the user.** Typed execution events only.

---

## Repository layout

```
packages/     pure libraries — ports only, no HTTP, no database driver
services/     api (HTTP surface) and worker (ingestion, evaluation, delivery)
apps/         dashboard, demo SaaS, deliberately-vulnerable app, docs site
migrations/   forward-only SQL
tests/        integration, e2e, security, load
docs/         architecture, security, research, roadmap, build prompts
deploy/       docker and compose assets
```

`packages/*` may never import from `services/*` or `apps/*`, and `packages/contracts` may
import nothing from the workspace. This is enforced in CI by a job that injects a violating
import and asserts the check fails — the rule is tested, not trusted.

---

## Getting started

```bash
corepack enable
pnpm install
docker compose up -d      # postgres + pgvector, redis, minio
pnpm verify               # lint, typecheck, boundaries, test, build
```

`pnpm verify` should pass on a clean clone. If it does not, that is a bug — please open an issue.

### Commands

| Command | What it does |
|---|---|
| `pnpm verify` | Everything CI runs |
| `pnpm lint` / `pnpm format` | Biome check / write |
| `pnpm typecheck` | Project-wide TypeScript |
| `pnpm boundaries` | Dependency direction rules |
| `pnpm test` | Unit tests |
| `pnpm build` | Build all packages |

---

## Documentation

| Document | Covers |
|---|---|
| `docs/research/competitive-analysis.md` | The landscape, feature matrix, chosen differentiators |
| `docs/architecture/01-thesis-system-and-runtime.md` | Thesis, system architecture, agent runtime, model layer, error taxonomy |
| `docs/architecture/02-tools-openapi-mcp-client.md` | Tool contract, action tokens, OpenAPI, MCP, client tools, navigation |
| `docs/architecture/03-knowledge-identity-policy.md` | Retrieval with ACLs, identity, the policy engine |
| `docs/architecture/04-workflows-and-data-model.md` | Workflow graph and the PostgreSQL schema |
| `docs/architecture/05-api-sdk-cli-frontend.md` | REST API, SDKs, CLI, frontend architecture, design system |
| `docs/architecture/06-observability-and-evaluation.md` | OpenTelemetry, events, agent evaluation |
| `docs/security/threat-model.md` | Threats, controls, and the security test suite |
| `docs/ROADMAP.md` | Technology decisions, MVP scope, phases, risks, build order |
| `docs/build/session-prompts.md` | The 33 implementation sessions |
| `CLAUDE.md` | Working rules for this repository |

---

## Contributing

See `CONTRIBUTING.md`. Security issues: `SECURITY.md` — please report privately.

## License

Apache-2.0. The core stays open; no capability will be removed from it to create a
commercial upsell.
