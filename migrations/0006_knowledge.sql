-- 0006_knowledge.sql — the knowledge store (doc 03 Part A).
--
-- The shape here exists to serve one query: retrieval with the principal's ACL
-- as a predicate *inside* the scan. Everything else follows from that. In
-- particular `visibility` and `acl_tags` live on the document rather than being
-- resolved through a join table, because a join the planner can reorder is a
-- join that can be evaluated after the rows have already been read.
--
-- The runner wraps this file in a transaction. No BEGIN/COMMIT.

-- The first migration that needs it. Not added to 0001 retroactively: that
-- file's checksum is recorded, and editing an applied migration is the exact
-- thing the runner refuses to let anyone do.
create extension if not exists vector;

create table knowledge_sources (
  id           text primary key default keel_id('ksr')
                 check (id ~ '^ksr_[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id       text not null,
  project_id   text not null,
  kind         text not null check (kind in ('upload', 'website', 'notion', 'http', 'push')),
  name         text not null,
  config       jsonb not null default '{}'::jsonb,
  -- Per doc 03 §A3. `partial` is deliberately a first-class outcome: a source
  -- that indexed 374 of 412 documents is not `ready`, and calling it ready is
  -- how stale-answer incidents happen.
  state        text not null default 'pending'
                 check (state in ('pending', 'crawling', 'parsing', 'indexing',
                                  'ready', 'partial', 'failed')),
  error_count  integer not null default 0 check (error_count >= 0),
  last_sync_at timestamptz,
  created_at   timestamptz not null default now(),
  foreign key (project_id, org_id) references projects (id, org_id) on delete cascade,
  unique (id, org_id)
);

create table knowledge_documents (
  id             text primary key default keel_id('kdc')
                   check (id ~ '^kdc_[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id         text not null,
  project_id     text not null,
  source_id      text not null,
  uri            text not null,
  title          text,
  -- Change detection (doc 03 §A1). Unchanged content means no re-parse and no
  -- re-embed, which on a docs-site re-crawl is the difference between
  -- re-embedding 4,000 chunks and re-embedding 40.
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  -- The three-way visibility from doc 03 §A2. Checked inside the retrieval
  -- query, never after it.
  visibility     text not null default 'org' check (visibility in ('public', 'org', 'acl')),
  -- Derived from *verified identity claims only* — group and role claims in the
  -- customer's signed token. Never from anything a client asserts.
  acl_tags       text[] not null default '{}',
  -- Points at the version retrieval should read. Bumped atomically when a new
  -- version is indexed, so a half-indexed version is never live.
  current_version_id text,
  fetched_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  deleted_at     timestamptz,
  foreign key (source_id, org_id) references knowledge_sources (id, org_id) on delete cascade,
  foreign key (project_id, org_id) references projects (id, org_id) on delete cascade,
  unique (id, org_id),
  unique (source_id, uri),
  -- An `acl` document with no tags is visible to nobody, which is a
  -- configuration mistake that should fail loudly rather than silently hide
  -- content its owner believes is shared.
  -- coalesce is load-bearing: array_length('{}', 1) is NULL, and a CHECK only
  -- fails on FALSE, so without it an acl document with no tags would sail
  -- through — the exact configuration this constraint exists to catch.
  constraint knowledge_documents_acl_has_tags
    check (visibility <> 'acl' or coalesce(array_length(acl_tags, 1), 0) >= 1)
);

-- Insert-only (hard rule 8). A correction is a new version.
create table document_versions (
  id             text primary key default keel_id('kdv')
                   check (id ~ '^kdv_[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id         text not null,
  document_id    text not null,
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  text           text not null,
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  foreign key (document_id, org_id) references knowledge_documents (id, org_id) on delete cascade,
  unique (id, org_id),
  unique (document_id, content_sha256)
);

-- Insert-only, the same way agent_versions and tool_versions are: the trigger
-- refuses an UPDATE, and keel_app is granted no update or delete privilege at
-- all, so the invariant survives someone dropping the trigger.
create trigger document_versions_insert_only
  before update on document_versions
  for each row execute function keel_reject_update();

alter table knowledge_documents
  add constraint knowledge_documents_current_version_fk
  foreign key (current_version_id, org_id) references document_versions (id, org_id);

create table knowledge_chunks (
  id                  text primary key default keel_id('kch')
                        check (id ~ '^kch_[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id              text not null,
  document_id         text not null,
  document_version_id text not null,
  seq                 integer not null check (seq >= 0),
  -- Content-addressed, so an unchanged chunk keeps its embedding across a
  -- re-index (doc 03 §A1).
  content_sha256      text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  content             text not null,
  -- "Billing → Refunds → Eligibility" rather than an anonymous fragment.
  heading_path        text[] not null default '{}',
  token_count         integer not null default 0 check (token_count >= 0),
  embedding           vector(384),
  tsv                 tsvector,
  created_at          timestamptz not null default now(),
  foreign key (document_id, org_id) references knowledge_documents (id, org_id) on delete cascade,
  foreign key (document_version_id, org_id) references document_versions (id, org_id) on delete cascade,
  unique (id, org_id),
  unique (document_version_id, seq)
);

-- Maintained by the database, not by the application: a chunk written by a path
-- that forgot to populate the tsvector would be silently unfindable by keyword.
create function knowledge_chunks_tsv() returns trigger language plpgsql as $$
begin
  new.tsv := to_tsvector('english', coalesce(new.content, ''));
  return new;
end;
$$;

create trigger knowledge_chunks_tsv_biu
  before insert or update of content on knowledge_chunks
  for each row execute function knowledge_chunks_tsv();

create index knowledge_sources_org_idx on knowledge_sources (org_id);
create index knowledge_documents_org_idx on knowledge_documents (org_id);
create index knowledge_documents_project_idx on knowledge_documents (project_id) where deleted_at is null;
create index knowledge_documents_sha_idx on knowledge_documents (source_id, content_sha256);
-- GIN over the tags, because the ACL predicate is an array overlap and it has
-- to be index-assisted or the "inside the query" property costs a seq scan.
create index knowledge_documents_acl_idx on knowledge_documents using gin (acl_tags);
create index document_versions_org_idx on document_versions (org_id);
create index knowledge_chunks_org_idx on knowledge_chunks (org_id);
create index knowledge_chunks_version_idx on knowledge_chunks (document_version_id);
create index knowledge_chunks_tsv_idx on knowledge_chunks using gin (tsv);
create index knowledge_chunks_embedding_idx on knowledge_chunks
  using hnsw (embedding vector_cosine_ops);

comment on column knowledge_documents.acl_tags is
  'Derived from verified identity claims only (groups/roles in the customer signed token). Never from client-supplied values.';
comment on column knowledge_chunks.content_sha256 is
  'Content-addressed so an unchanged chunk keeps its embedding across a re-index.';

grant select, insert, update, delete on knowledge_sources to keel_app;
grant select, insert, update, delete on knowledge_documents to keel_app;
grant select, insert on document_versions to keel_app;
grant select, insert, update, delete on knowledge_chunks to keel_app;

alter table knowledge_sources enable row level security;
alter table knowledge_sources force  row level security;
alter table knowledge_documents enable row level security;
alter table knowledge_documents force  row level security;
alter table document_versions enable row level security;
alter table document_versions force  row level security;
alter table knowledge_chunks enable row level security;
alter table knowledge_chunks force  row level security;

create policy knowledge_sources_org_isolation on knowledge_sources
  as permissive for all to public
  using      (org_id = keel_current_org_id())
  with check (org_id = keel_current_org_id());

create policy knowledge_documents_org_isolation on knowledge_documents
  as permissive for all to public
  using      (org_id = keel_current_org_id())
  with check (org_id = keel_current_org_id());

create policy document_versions_org_isolation on document_versions
  as permissive for all to public
  using      (org_id = keel_current_org_id())
  with check (org_id = keel_current_org_id());

create policy knowledge_chunks_org_isolation on knowledge_chunks
  as permissive for all to public
  using      (org_id = keel_current_org_id())
  with check (org_id = keel_current_org_id());
