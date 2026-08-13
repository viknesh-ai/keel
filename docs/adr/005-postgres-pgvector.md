# ADR-005: PostgreSQL + pgvector rather than a dedicated vector database

- **Status:** accepted
- **Date:** 2026-08-13
- **Deciders:** Keel maintainers

## Context

Keel retrieves knowledge on behalf of an authenticated end user of someone else's SaaS. Every
retrieval is therefore an authorization decision as much as a relevance decision: the same query
must rank chunks by similarity *and* exclude the ones this principal may not see.

The data model (`docs/architecture/04` Part B) already needs relational storage for tenancy,
runs, step logs, policy and approvals. Retrieval adds two more access patterns — full-text search
and vector similarity — over `knowledge_chunks`, which carries a denormalised `visibility`,
`acl_tags text[]` and `org_id` precisely so the permission filter can live inside the index scan.

The product also promises `docker compose up` produces a working system with no external API keys
(ROADMAP §3). Every additional stateful service is a service the self-hoster has to run, back up,
upgrade and debug.

## Problem

Where do embeddings live: in the same PostgreSQL instance as everything else, or in a dedicated
vector database?

## Decision

**One PostgreSQL 16 database with the `pgvector` extension.** Relational rows, full-text `tsvector`
and `vector(N)` embeddings live in the same database, and hybrid retrieval (FTS + vector + RRF)
runs as SQL against it.

The ACL predicate is a `WHERE` clause in the same statement as the similarity search. It is not a
post-filter applied to results, and it is not a second round trip.

Retrieval sits behind an interface from day one (`packages/knowledge-engine`) so this is a
storage decision, not an architectural one.

## Alternatives considered

**Qdrant, Weaviate or Milvus alongside Postgres.** Genuinely better at pure vector workloads:
superior index tuning, quantisation, distributed sharding, and higher recall at scale. They lost
on the security property. Correct permission filtering across two stores means either replicating
the ACL into the vector store and keeping it consistent — a cache invalidation problem on the
security path, which is the worst place to have one — or over-fetching and post-filtering, which
silently degrades recall in exactly the way that is hardest to detect: the user gets *an* answer,
just not the one they were entitled to. It also adds a second stateful service to every self-host,
against the one-command-install promise.

**pgvector in a separate Postgres instance.** Keeps the extension without co-locating the data.
Same cross-store consistency problem as above, with none of the performance upside. No honest case.

**SQLite + sqlite-vec.** Attractive for single-node self-hosting and genuinely fast. Rejected
because ADR-006 puts the job queue in the same database using `FOR UPDATE SKIP LOCKED`, and
because concurrent multi-process access (api + worker) is exactly SQLite's weak point.

## Consequences

**Easier.** One connection string, one backup, one restore, one upgrade path. Transactions span
documents, chunks and embeddings, so an ingestion run is atomic. The ACL filter is enforced by the
same Postgres RLS and `WHERE` clauses as the rest of the system rather than by a second, differently
shaped mechanism. Local development needs one container.

**Harder.** HNSW index builds are memory-hungry and lock-sensitive; large re-embeddings need care.
`pgvector` recall/latency at high dimensionality is below a tuned dedicated store. We inherit
Postgres's connection-count ceiling for a workload that would otherwise be isolated.

**Committed to.** Embedding dimensionality is a schema decision, not a config toggle — changing it
is a migration and a re-embed. Retrieval must stay behind the `knowledge-engine` interface so the
storage swap stays mechanical. A published benchmark and a documented migration path are owed to
users before they hit the ceiling, not after (ROADMAP R9).

## Revisit when

Any of: a single tenant exceeds ~10M chunks; p95 retrieval latency exceeds 300ms with a tuned HNSW
index and the ACL predicate in place; or measured recall against our evaluation set falls below what
a dedicated store demonstrably delivers on the same corpus. Curiosity about a faster vector store is
not a trigger — a measurement is.
