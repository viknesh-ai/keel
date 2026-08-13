# ADR-006: Postgres/Redis queueing rather than Temporal

- **Status:** accepted
- **Date:** 2026-08-13
- **Deciders:** Keel maintainers

## Context

Keel runs work that must survive process death: agent turns that pause for human approval, tool
calls that must execute exactly once, ingestion and embedding jobs, webhook deliveries with retry
and dead-lettering, and scheduled evaluation runs.

The runtime already persists a step log — `run_steps` is append-only and `(run_id, seq)` unique
(`docs/architecture/04` §B1) — because traces, replay and evaluation all need it independently of
durability. That log is a complete record of what a run did and where it got to.

Deployment shape is a modular monolith plus one worker (ADR-001), and `docker compose up` must
produce a working system (ROADMAP §3). ADR-005 already puts the primary datastore in PostgreSQL.

## Problem

What provides durable execution and job dispatch: a dedicated workflow engine, or the datastore
we already run?

## Decision

**PostgreSQL `SELECT … FOR UPDATE SKIP LOCKED` for durable job claiming, with Redis Streams for
low-latency fan-out and transient coordination.** Durability lives in Postgres; Redis is an
accelerator and is never the system of record.

Recovery is derived from the persisted step log rather than from queue state. A worker that dies
mid-job leaves a claimable row; a run that dies mid-turn is resumed by replaying its steps.

## Alternatives considered

**Temporal.** The technically strongest option: battle-tested durable execution, deterministic
replay, versioning, visibility tooling, and a mature SDK. It lost on operability, not capability.
Temporal is a cluster — frontend, history, matching and worker services plus its own datastore —
and self-hosters would have to run and upgrade it before Keel does anything at all. That is a
direct contradiction of the one-command-install promise, and for an OSS project the install
funnel is the adoption funnel. Recorded here as the Phase 3 option for high-volume deployments,
where the operational cost is justified by throughput.

**Restate / DBOS.** Lighter than Temporal and genuinely well-designed; DBOS in particular stores
state in Postgres, which fits. Both lost on maturity relative to the risk: they sit on the
critical path for every mutation Keel performs, the ecosystems are young, and adopting one means
inheriting its failure modes into our security-critical execution path. Reconsider if DBOS's
Postgres-native model proves out.

**BullMQ (Redis-backed).** Ergonomic and widely used. Rejected because it makes Redis the system
of record for job state, which forces Redis persistence to be as trustworthy as Postgres's, and
because a job's state would then live in a different store from the step log it corresponds to —
two sources of truth about the same run.

**Celery.** Python-first. ADR-002 puts the control plane in TypeScript; adding a Python runtime to
every deployment for job dispatch is not a trade worth making.

## Consequences

**Easier.** No new service to install, operate or upgrade. Job claim and business write commit in
the same transaction, so "job done but result lost" is unrepresentable rather than merely unlikely.
Deterministic replay falls out of the step log, which evaluation needs anyway. A self-hoster
debugging a stuck job uses `psql`.

**Harder.** We own the executor: visibility timeouts, poison-message handling, backoff, fairness
across tenants, and the scheduler are ours to write and test. There is no equivalent of Temporal's
Web UI, so run inspection has to be built (it is — the run-detail trace screen, ROADMAP Slice 1).
Polling costs a query per worker per interval, and long-polling with `LISTEN`/`NOTIFY` has its own
edges. Postgres becomes the throughput ceiling for both data and dispatch.

**Committed to.** The step log is load-bearing for correctness, not just for observability —
`run_steps` stays append-only and corrections are new steps. Queue access must stay behind a port
in `packages/agent-runtime` so a Temporal-backed implementation is additive rather than a rewrite.

## Revisit when

Sustained dispatch exceeds roughly 100 jobs/second on a single Postgres primary, or queue polling
becomes a measurable share of database load, or a deployment needs cross-region workers. Any of
those makes Temporal's operational cost the cheaper side of the trade — for that deployment, as an
option, not as a replacement for the default path.
