-- 0003_conversations_and_runs.sql — the trace.
--
-- Reference: docs/architecture/04-workflows-and-data-model.md Part B.
--
-- ONE DELIBERATE DEVIATION, recorded in doc 04 §B1 in this same change:
--
--   The doc asks for `run_steps` partitioned monthly by started_at AND for
--   (run_id, seq) to be unique. In PostgreSQL those two cannot both hold: a
--   unique constraint on a partitioned table must contain the partition key, so
--   the strongest constraint available is UNIQUE (run_id, seq, started_at),
--   which permits the same (run_id, seq) in two different months.
--
--   That is not hypothetical. A run that pauses in AwaitingApproval can outlive
--   a month boundary, and its later steps land in the next partition.
--
--   Resolution: sequence numbers are allocated from a counter on `runs`, taken
--   under that row's lock, so (run_id, seq) is unique by construction rather
--   than by constraint. The per-partition unique index stays as defence in
--   depth against a caller that writes seq itself.
--
-- The runner wraps this file in a transaction. No BEGIN/COMMIT.

-- ---------------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------------

create table conversations (
  id                 text primary key default keel_id('conv')
                       check (id ~ '^conv_[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id             text not null,
  project_id         text not null,
  environment_id     text not null,
  identity_id        text,
  agent_version_id   text not null,
  title              text,
  status             text not null default 'open'
                       check (status in ('open', 'closed', 'archived')),
  started_at         timestamptz not null default now(),
  last_activity_at   timestamptz not null default now(),
  metadata           jsonb not null default '{}'::jsonb,
  foreign key (project_id, org_id)       references projects (id, org_id) on delete cascade,
  foreign key (environment_id, org_id)   references environments (id, org_id) on delete cascade,
  foreign key (agent_version_id, org_id) references agent_versions (id, org_id),
  unique (id, org_id)
);

create index conversations_org_id_idx on conversations (org_id);
create index conversations_project_activity_idx
  on conversations (project_id, last_activity_at desc);

create table messages (
  id               text primary key default keel_id('msg')
                     check (id ~ '^msg_[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id           text not null,
  conversation_id  text not null,
  role             text not null check (role in ('user', 'assistant', 'system')),
  content          text not null,
  run_id           text,
  created_at       timestamptz not null default now(),
  foreign key (conversation_id, org_id) references conversations (id, org_id) on delete cascade
);

create index messages_org_id_idx on messages (org_id);
create index messages_conversation_idx on messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Runs
-- ---------------------------------------------------------------------------

create table runs (
  id                text primary key default keel_id('run')
                      check (id ~ '^run_[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id            text not null,
  project_id        text not null,
  environment_id    text not null,
  conversation_id   text,
  agent_version_id  text not null,
  identity_id       text,
  trigger           text not null
                      check (trigger in ('chat', 'api', 'webhook', 'schedule', 'eval')),
  -- The lifecycle from doc 01 §4.3. Stored as text rather than an enum type so
  -- adding a state is a migration, not an ALTER TYPE that locks the table.
  state             text not null default 'Authenticating'
                      check (state in ('Authenticating', 'AssemblingContext', 'ResolvingIntent',
                                       'Deterministic', 'Retrieving', 'Planning', 'Selecting',
                                       'Authorizing', 'AwaitingApproval', 'Executing',
                                       'Observing', 'Verifying', 'Recovering', 'Responding',
                                       'WorkflowRunning', 'Denied', 'Expired', 'Cancelled',
                                       'Failed', 'Completed')),
  idempotency_key   text,
  simulated         boolean not null default false,
  -- Sequence allocator for run_steps. See the header: this is what makes
  -- (run_id, seq) unique across partitions.
  next_seq          integer not null default 1 check (next_seq >= 1),
  started_at        timestamptz not null default now(),
  ended_at          timestamptz,
  error_class       text,
  cost_usd          numeric(12, 6) not null default 0 check (cost_usd >= 0),
  tokens_in         integer not null default 0 check (tokens_in >= 0),
  tokens_out        integer not null default 0 check (tokens_out >= 0),
  foreign key (project_id, org_id)       references projects (id, org_id) on delete cascade,
  foreign key (environment_id, org_id)   references environments (id, org_id) on delete cascade,
  foreign key (conversation_id, org_id)  references conversations (id, org_id) on delete set null,
  foreign key (agent_version_id, org_id) references agent_versions (id, org_id),
  unique (id, org_id),
  -- Replaying a request with the same key must not start a second run.
  unique (project_id, idempotency_key)
);

create index runs_org_id_idx on runs (org_id);
create index runs_project_started_idx on runs (project_id, started_at desc);
create index runs_state_idx on runs (state) where ended_at is null;
create index runs_conversation_idx on runs (conversation_id, started_at desc);

alter table messages
  add constraint messages_run_fk
  foreign key (run_id, org_id) references runs (id, org_id) on delete set null;

-- ---------------------------------------------------------------------------
-- run_steps — the highest-volume table and the backbone of traces, evaluation
-- and replay. Append-only; corrections are new steps (doc 04 §B3 invariant 4).
--
-- Partitioned monthly so retention prunes partitions rather than deleting rows:
-- DROP TABLE on a month is instant, DELETE over millions of rows is not.
-- ---------------------------------------------------------------------------

create table run_steps (
  id               text not null default keel_id('step')
                     check (id ~ '^step_[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id           text not null,
  run_id           text not null,
  seq              integer not null check (seq >= 1),
  type             text not null
                     check (type in ('context', 'retrieval', 'model', 'tool', 'policy',
                                     'approval', 'verify', 'recover', 'route', 'response')),
  status           text not null check (status in ('ok', 'error', 'skipped', 'pending')),
  payload          jsonb not null default '{}'::jsonb,
  -- The trust level from packages/contracts integrity.ts, travelling with the
  -- step so a replay can re-derive taint without guessing.
  integrity        text not null default 'system'
                     check (integrity in ('system', 'developer', 'user', 'tool', 'external')),
  error_class      text,
  tool_version_id  text,
  model            text,
  tokens_in        integer not null default 0 check (tokens_in >= 0),
  tokens_out       integer not null default 0 check (tokens_out >= 0),
  cost_usd         numeric(12, 6) not null default 0 check (cost_usd >= 0),
  latency_ms       integer check (latency_ms >= 0),
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  -- The partition key has to be part of every unique constraint, which is why
  -- started_at appears here and why seq alone is not enough. See the header.
  primary key (id, started_at)
) partition by range (started_at);

-- Per-partition. Global (run_id, seq) uniqueness comes from runs.next_seq.
create unique index run_steps_run_seq_idx on run_steps (run_id, seq, started_at);
create index run_steps_org_id_idx on run_steps (org_id);
create index run_steps_run_idx on run_steps (run_id, seq);
create index run_steps_type_idx on run_steps (type, started_at desc);

-- Creates the partition covering a given month if it is not already there.
-- Called by the runner below for a starting window, and by the worker on a
-- schedule once one exists. Idempotent so it is safe to call on every boot.
create function keel_ensure_run_steps_partition(p_month date) returns text
  language plpgsql
as $$
declare
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name  text := 'run_steps_' || to_char(v_start, 'YYYY_MM');
begin
  if to_regclass('public.' || v_name) is null then
    execute format(
      'create table %I partition of run_steps for values from (%L) to (%L)',
      v_name, v_start, v_end);
    execute format('alter table %I enable row level security', v_name);
    execute format('alter table %I force row level security', v_name);
    execute format('grant select, insert on %I to keel_app', v_name);
  end if;
  return v_name;
end;
$$;

-- A window around today, so a fresh install can write steps immediately and
-- keep writing for a year without an operator remembering to do anything.
do $$
declare
  m integer;
begin
  for m in -1..12 loop
    perform keel_ensure_run_steps_partition((current_date + (m || ' months')::interval)::date);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants and row level security
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on conversations to keel_app;
grant select, insert, update, delete on messages      to keel_app;
grant select, insert, update         on runs          to keel_app;
-- Append-only: no UPDATE, no DELETE, enforced by privilege as well as by
-- convention. A correction is a new step.
grant select, insert                 on run_steps     to keel_app;

alter table conversations enable row level security;
alter table conversations force  row level security;
alter table messages      enable row level security;
alter table messages      force  row level security;
alter table runs          enable row level security;
alter table runs          force  row level security;
alter table run_steps     enable row level security;
alter table run_steps     force  row level security;

create policy conversations_org_isolation on conversations
  as permissive for all to public
  using      (org_id = keel_current_org_id())
  with check (org_id = keel_current_org_id());

create policy messages_org_isolation on messages
  as permissive for all to public
  using      (org_id = keel_current_org_id())
  with check (org_id = keel_current_org_id());

create policy runs_org_isolation on runs
  as permissive for all to public
  using      (org_id = keel_current_org_id())
  with check (org_id = keel_current_org_id());

-- Declared on the parent; PostgreSQL applies it to every partition, including
-- ones created later by keel_ensure_run_steps_partition.
create policy run_steps_org_isolation on run_steps
  as permissive for all to public
  using      (org_id = keel_current_org_id())
  with check (org_id = keel_current_org_id());
