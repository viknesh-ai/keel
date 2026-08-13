-- 0002_agents_and_tools.sql — agents, tools, and their immutable versions.
--
-- Reference: docs/architecture/04-workflows-and-data-model.md Part B.
--
-- Same tenancy shape as 0001: org_id on every table, denormalised where the doc
-- scopes only by project, with a composite FK so the two cannot diverge. RLS
-- ENABLEd and FORCEd, one policy per table per command.
--
-- The runner wraps this file in a transaction. No BEGIN/COMMIT.

-- ---------------------------------------------------------------------------
-- Backfill from 0001
--
-- environments needs a unique (id, org_id) for the composite foreign keys added
-- below to point at. 0001 is already applied and its checksum is recorded, so
-- the fix goes forward into this migration rather than editing an applied file
-- — which is exactly the discipline the runner enforces.
-- ---------------------------------------------------------------------------

alter table environments add constraint environments_id_org_key unique (id, org_id);

-- ---------------------------------------------------------------------------
-- Insert-only enforcement
--
-- Doc 04 §B3 invariant 2: agent_versions, tool_versions, workflow_versions,
-- policy_versions and document_versions are insert-only. Publishing creates a
-- row; nothing updates one.
--
-- A convention is not an invariant. This trigger is what makes it one, and it
-- is deliberately a hard ERROR rather than a silent no-op: a caller that tried
-- to mutate a published version has a bug, and swallowing it would hide the bug
-- while producing a run whose recorded version no longer describes what ran.
-- ---------------------------------------------------------------------------

create function keel_reject_update() returns trigger
  language plpgsql
as $$
begin
  raise exception
    'relation % is insert-only; publish a new version instead of updating %',
    tg_table_name, old.id
    using errcode = 'restrict_violation';
end;
$$;

-- ---------------------------------------------------------------------------
-- Agents
-- ---------------------------------------------------------------------------

create table agents (
  id                  text primary key default keel_id('agt')
                        check (id ~ '^agt_[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id              text not null,
  project_id          text not null,
  name                text not null check (length(name) between 1 and 200),
  slug                text not null
                        check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  -- Set after the first publish. Nullable because an agent exists before it has
  -- a version, and pretending otherwise would force a chicken-and-egg insert.
  current_version_id  text,
  created_at          timestamptz not null default now(),
  foreign key (project_id, org_id) references projects (id, org_id) on delete cascade,
  unique (project_id, slug),
  unique (id, org_id)
);

create index agents_org_id_idx on agents (org_id);
create index agents_project_id_idx on agents (project_id);

create table agent_versions (
  id                     text primary key default keel_id('av')
                           check (id ~ '^av_[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id                 text not null,
  agent_id               text not null,
  version                integer not null check (version >= 1),
  instructions           text not null,
  model_config           jsonb not null default '{}'::jsonb,
  tool_selection         text[] not null default '{}',
  knowledge_snapshot_id  text,
  policy_version_id      text,
  workflow_bindings      jsonb not null default '[]'::jsonb,
  published_at           timestamptz not null default now(),
  published_by           text,
  notes                  text,
  foreign key (agent_id, org_id) references agents (id, org_id) on delete cascade,
  unique (agent_id, version),
  unique (id, org_id)
);

create index agent_versions_org_id_idx on agent_versions (org_id);
create index agent_versions_agent_id_idx on agent_versions (agent_id, version desc);

create trigger agent_versions_insert_only
  before update on agent_versions
  for each row execute function keel_reject_update();

-- Deferred so the two tables can reference each other without an ordering
-- problem at publish time.
alter table agents
  add constraint agents_current_version_fk
  foreign key (current_version_id, org_id) references agent_versions (id, org_id)
  deferrable initially deferred;

-- ---------------------------------------------------------------------------
-- Tools
-- ---------------------------------------------------------------------------

create table tools (
  id                  text primary key default keel_id('tool')
                        check (id ~ '^tool_[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id              text not null,
  project_id          text not null,
  name                text not null
                        check (name ~ '^[a-z][a-z0-9_]*$' and length(name) between 1 and 64),
  target              text not null
                        check (target in ('server', 'client', 'mcp', 'openapi',
                                          'workflow', 'knowledge', 'navigation')),
  current_version_id  text,
  -- CLAUDE.md hard rule 6: default-deny. A newly imported tool is disabled
  -- until someone turns it on, so an OpenAPI import cannot silently widen what
  -- the agent can do.
  enabled             boolean not null default false,
  created_at          timestamptz not null default now(),
  foreign key (project_id, org_id) references projects (id, org_id) on delete cascade,
  unique (project_id, name),
  unique (id, org_id)
);

create index tools_org_id_idx on tools (org_id);
create index tools_project_id_idx on tools (project_id);
create index tools_enabled_idx on tools (project_id, enabled);

create table tool_versions (
  id          text primary key default keel_id('tv')
                check (id ~ '^tv_[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id      text not null,
  tool_id     text not null,
  version     integer not null check (version >= 1),
  -- The full ToolContract from packages/contracts. Stored as emitted JSON
  -- Schema so a six-week-old run's trace still describes the tool it called.
  contract    jsonb not null,
  source      text not null check (source in ('openapi', 'mcp', 'client', 'native')),
  source_ref  text,
  checksum    text not null check (checksum ~ '^[a-f0-9]{64}$'),
  created_at  timestamptz not null default now(),
  foreign key (tool_id, org_id) references tools (id, org_id) on delete cascade,
  unique (tool_id, version),
  unique (id, org_id)
);

create index tool_versions_org_id_idx on tool_versions (org_id);
create index tool_versions_tool_id_idx on tool_versions (tool_id, version desc);

create trigger tool_versions_insert_only
  before update on tool_versions
  for each row execute function keel_reject_update();

alter table tools
  add constraint tools_current_version_fk
  foreign key (current_version_id, org_id) references tool_versions (id, org_id)
  deferrable initially deferred;

-- A tool version's binding to one environment: where it points and which
-- secret it uses. Secrets are refs, never values (CLAUDE.md hard rule 4).
create table tool_bindings (
  id               text primary key default keel_id('tb')
                     check (id ~ '^tb_[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id           text not null,
  tool_version_id  text not null,
  environment_id   text not null,
  auth_binding     jsonb not null default '{"kind":"none"}'::jsonb,
  base_url         text,
  -- A ref into the secret provider. The CHECK is the control: a plaintext
  -- credential cannot satisfy this pattern, so storing one is a constraint
  -- violation rather than something a reviewer has to notice.
  secret_ref       text check (secret_ref is null or secret_ref ~ '^[a-z][a-z0-9+.-]*://'),
  enabled          boolean not null default false,
  created_at       timestamptz not null default now(),
  foreign key (tool_version_id, org_id) references tool_versions (id, org_id) on delete cascade,
  foreign key (environment_id, org_id) references environments (id, org_id) on delete cascade,
  unique (tool_version_id, environment_id)
);

create index tool_bindings_org_id_idx on tool_bindings (org_id);
create index tool_bindings_environment_idx on tool_bindings (environment_id, enabled);

comment on column tool_bindings.secret_ref is
  'A URI into the secret provider, e.g. env://KEY or vault://path. Never a value.';

-- ---------------------------------------------------------------------------
-- Grants and row level security
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on agents         to keel_app;
grant select, insert, update, delete on tools          to keel_app;
grant select, insert, update, delete on tool_bindings  to keel_app;
-- Version tables are insert-only by trigger; withholding UPDATE and DELETE as
-- well means the invariant survives someone dropping the trigger.
grant select, insert on agent_versions to keel_app;
grant select, insert on tool_versions  to keel_app;

alter table agents         enable row level security;
alter table agents         force  row level security;
alter table agent_versions enable row level security;
alter table agent_versions force  row level security;
alter table tools          enable row level security;
alter table tools          force  row level security;
alter table tool_versions  enable row level security;
alter table tool_versions  force  row level security;
alter table tool_bindings  enable row level security;
alter table tool_bindings  force  row level security;

create policy agents_org_isolation on agents
  as permissive for all to public
  using      (org_id = keel_current_org_id())
  with check (org_id = keel_current_org_id());

create policy agent_versions_org_isolation on agent_versions
  as permissive for all to public
  using      (org_id = keel_current_org_id())
  with check (org_id = keel_current_org_id());

create policy tools_org_isolation on tools
  as permissive for all to public
  using      (org_id = keel_current_org_id())
  with check (org_id = keel_current_org_id());

create policy tool_versions_org_isolation on tool_versions
  as permissive for all to public
  using      (org_id = keel_current_org_id())
  with check (org_id = keel_current_org_id());

create policy tool_bindings_org_isolation on tool_bindings
  as permissive for all to public
  using      (org_id = keel_current_org_id())
  with check (org_id = keel_current_org_id());
