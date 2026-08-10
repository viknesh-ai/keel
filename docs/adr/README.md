# Architecture Decision Records

One file per decision, `NNN-kebab-title.md`, using `TEMPLATE.md`.

Records are immutable once accepted. A changed decision gets a new ADR that supersedes the old
one; the old file stays, marked superseded. The value is the reasoning trail, not the current
state — the current state is the code.

## Index

Decisions summarised in `docs/ROADMAP.md` §2, to be written up individually as they are
implemented. Numbers are reserved so cross-references in the architecture docs stay stable.

| # | Decision | Status |
|---|---|---|
| 001 | Modular monolith rather than microservices | to write |
| 002 | TypeScript across the control plane | to write |
| 003 | AG-UI as the frontend wire protocol | to write |
| 004 | Target MCP 2026-07-28 with 2025-11-25 fallback | to write |
| 005 | PostgreSQL + pgvector rather than a dedicated vector database | to write |
| 006 | Postgres/Redis queueing rather than Temporal | to write |
| 007 | Own step-log durable executor | to write |
| 008 | Zod as authoring format, JSON Schema as wire format | to write |
| 009 | Declarative policy language rather than Rego or Cedar | to write |
| 010 | Vite SPA dashboard rather than Next.js | to write |
| 011 | XYFlow for the workflow canvas | to write |
| 012 | OpenTelemetry for observability | to write |
| 013 | Auth.js with optional OIDC | to write |
| 014 | Secret provider interface | to write |
| 015 | Local embeddings by default | to write |
| 016 | Action token design | to write |
| 017 | Taint invariants I1 and I2 | to write |
| 018 | No chain-of-thought exposure | to write |
| 019 | Apache-2.0 with no open-core gating | to write |
| 020 | Evaluation asserts on trajectories | to write |
