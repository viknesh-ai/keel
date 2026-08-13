-- 0001_init.sql — tenancy and identity.
--
-- organizations, users, memberships, projects, environments, api_keys.
-- Reference: docs/architecture/04-workflows-and-data-model.md Part B.
--
-- The runner wraps this file in a single transaction. Do not add BEGIN/COMMIT.
--
-- Two consequences of the RLS below are load-bearing and easy to trip over, so
-- they are stated here rather than discovered at 2am:
--
--   1. RLS is FORCEd on every table, so the table owner is subject to it too.
--      Any process that writes tenant rows -- a future data migration, a seed
--      script, the integration-test fixture -- must set keel.org_id first.
--      A non-superuser pg_dump will therefore dump zero tenant rows. Take
--      backups as a superuser.
--   2. keel_app is a cluster-global role. Creating it needs CREATEROLE or
--      superuser on the migrating role, and it is a no-op on the second and
--      subsequent databases in the same cluster.

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

create extension if not exists pgcrypto;    -- gen_random_bytes, for ULID entropy

-- ---------------------------------------------------------------------------
-- Identifiers
--
-- Prefixed ULIDs (doc 04 Part B): 48 bits of millisecond timestamp then 80 bits
-- of CSPRNG entropy, Crockford base32, 26 characters. Sortable by creation
-- time, and the prefix makes a stray id in a log name its own table.
--
-- The application supplies ids explicitly in normal operation. These defaults
-- exist so that psql sessions and test fixtures do not have to.
-- ---------------------------------------------------------------------------

create function keel_ulid() returns text
  language plpgsql
  volatile
as $$
declare
  v_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_bits     bit(130);
  v_out      text := '';
  i          integer;
begin
  v_bits :=
       b'00'
    || substring(
         (floor(extract(epoch from clock_timestamp()) * 1000)::bigint)::bit(64)
         from 17 for 48)
    || ('x' || encode(gen_random_bytes(10), 'hex'))::bit(80);

  for i in 0..25 loop
    v_out := v_out
          || substr(v_alphabet, (substring(v_bits from i * 5 + 1 for 5)::integer) + 1, 1);
  end loop;

  return v_out;
end;
$$;

create function keel_id(p_prefix text) returns text
  language sql
  volatile
as $$ select p_prefix || '_' || keel_ulid() $$;

-- ---------------------------------------------------------------------------
-- Session context
--
-- The active organization is carried in the keel.org_id session variable and is
-- read by every policy below. The two-argument form of current_setting returns
-- NULL when the variable has never been set, and NULL fails every comparison in
-- every policy -- so a connection that forgets to set it sees nothing and can
-- write nothing. Fail-closed is the default path, not a special case.
--
-- nullif(..., '') means an explicitly blank value behaves identically to unset,
-- rather than matching a row whose org_id is somehow ''.
--
-- Neither function is SECURITY DEFINER and neither pins search_path: both are
-- plain SQL over pg_catalog builtins, and CREATE on schema public is revoked
-- from PUBLIC below, so there is no schema an attacker could shadow them from.
-- Leaving the SET clause off keeps them inlinable into the policy predicates.
-- ---------------------------------------------------------------------------

create function keel_current_org_id() returns text
  language sql stable
as $$ select nullif(current_setting('keel.org_id', true), '') $$;

create function keel_current_user_id() returns text
  language sql stable
as $$ select nullif(current_setting('keel.user_id', true), '') $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table organizations (
  id          text primary key default keel_id('org')
                check (id ~ '^org_[0-9A-HJKMNP-TV-Z]{26}$'),
  name        text not null check (length(name) between 1 and 200),
  slug        text not null unique
                check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- Keel dashboard users. NOT tenant-scoped: one user may belong to many
-- organizations via memberships, and email uniqueness is global.
create table users (
  id             text primary key default keel_id('usr')
                   check (id ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
  email          text not null check (length(email) between 3 and 320),
  name           text not null check (length(name) between 1 and 200),
  auth_provider  text not null check (length(auth_provider) between 1 and 64),
  created_at     timestamptz not null default now()
);

create unique index users_email_lower_key on users (lower(email));

create table memberships (
  org_id      text not null references organizations (id) on delete cascade,
  user_id     text not null references users (id) on delete cascade,
  role        text not null check (role in ('owner', 'admin', 'developer', 'viewer')),
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);

create index memberships_user_id_idx on memberships (user_id);

create table projects (
  id          text primary key default keel_id('proj')
                check (id ~ '^proj_[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id      text not null references organizations (id) on delete cascade,
  name        text not null check (length(name) between 1 and 200),
  slug        text not null
                check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  unique (org_id, slug),
  -- Redundant given the primary key, but a composite foreign key needs a
  -- unique constraint on exactly these columns to point at.
  unique (id, org_id)
);

create index projects_org_id_idx on projects (org_id);

-- org_id is denormalised from projects (deviation from doc 04 Part B, recorded
-- there). The composite foreign key is what makes it trustworthy: an
-- environment cannot claim one organization while pointing at another's project.
create table environments (
  id          text primary key default keel_id('env')
                check (id ~ '^env_[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id      text not null,
  project_id  text not null,
  name        text not null check (name in ('development', 'staging', 'production')),
  config      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  foreign key (project_id, org_id) references projects (id, org_id) on delete cascade,
  unique (project_id, name)
);

create index environments_org_id_idx on environments (org_id);

create table api_keys (
  id            text primary key default keel_id('key')
                  check (id ~ '^key_[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id        text not null references organizations (id) on delete cascade,
  project_id    text,
  name          text not null check (length(name) between 1 and 200),
  -- SHA-256 of the presented key, lowercase hex. The CHECK is the control: a
  -- plaintext key cannot satisfy this pattern, so storing one is a constraint
  -- violation rather than a code review finding. SHA-256 rather than argon2
  -- because API keys are full-entropy random strings, not user-chosen
  -- passwords -- there is nothing to slow a guesser down against.
  hash          text not null unique check (hash ~ '^[a-f0-9]{64}$'),
  scopes        text[] not null default '{}',
  last_used_at  timestamptz,
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  foreign key (project_id, org_id) references projects (id, org_id) on delete cascade
);

create index api_keys_org_id_idx on api_keys (org_id);

comment on column api_keys.hash is
  'SHA-256 of the API key, hex. The key itself is shown once at creation and never stored.';

-- ---------------------------------------------------------------------------
-- Application role
--
-- keel_app owns nothing and holds no BYPASSRLS. A deployment creates a LOGIN
-- role, grants it keel_app, and connects the API as that. Connecting the API as
-- the database owner is a misconfiguration; FORCE ROW LEVEL SECURITY below is
-- what makes it a misconfiguration that fails closed instead of one that
-- silently returns every tenant's rows.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'keel_app') then
    create role keel_app nologin;
  end if;
end;
$$;

revoke create on schema public from public;
grant usage on schema public to keel_app;

grant select, insert, update          on organizations to keel_app;
grant select, insert, update          on users         to keel_app;
grant select, insert, update, delete  on memberships   to keel_app;
grant select, insert, update, delete  on projects      to keel_app;
grant select, insert, update, delete  on environments  to keel_app;
grant select, insert, update, delete  on api_keys      to keel_app;

-- No grant on schema_migrations. The application never reads it.

-- ---------------------------------------------------------------------------
-- Row level security
--
-- ENABLE turns policies on. FORCE additionally subjects the table owner to
-- them. Without FORCE, every policy below is decorative for any connection that
-- happens to be the owner -- which is the default in a self-host that has not
-- created a separate role.
-- ---------------------------------------------------------------------------

alter table organizations enable row level security;
alter table organizations force  row level security;
alter table users         enable row level security;
alter table users         force  row level security;
alter table memberships   enable row level security;
alter table memberships   force  row level security;
alter table projects      enable row level security;
alter table projects      force  row level security;
alter table environments  enable row level security;
alter table environments  force  row level security;
alter table api_keys      enable row level security;
alter table api_keys      force  row level security;

-- Every policy is TO public deliberately. A policy scoped TO keel_app would
-- leave any other role with no applicable policy -- also a deny, but a deny by
-- accident. TO public means one rule covers every role that exists now or
-- later, and there is exactly one rule per table per command to read.

create policy organizations_org_isolation on organizations
  as permissive for all to public
  using      (id = keel_current_org_id())
  with check (id = keel_current_org_id());

-- Split per command on purpose. A single FOR ALL policy would reuse the read
-- predicate (self OR co-member) as the USING clause for UPDATE and DELETE,
-- which would let any co-member delete any other co-member's account.
create policy users_select_self_or_co_member on users
  as permissive for select to public
  using (
       id = keel_current_user_id()
    or exists (
         select 1 from memberships m
          where m.user_id = users.id
            and m.org_id  = keel_current_org_id()
       )
  );

create policy users_insert_self on users
  as permissive for insert to public
  with check (id = keel_current_user_id());

create policy users_update_self on users
  as permissive for update to public
  using      (id = keel_current_user_id())
  with check (id = keel_current_user_id());

-- keel_app holds no DELETE grant on users, so this is denied twice over. The
-- policy exists so that a future GRANT DELETE cannot silently open a hole.
create policy users_delete_self on users
  as permissive for delete to public
  using (id = keel_current_user_id());

create policy memberships_org_isolation on memberships
  as permissive for all to public
  using      (org_id = keel_current_org_id())
  with check (org_id = keel_current_org_id());

create policy projects_org_isolation on projects
  as permissive for all to public
  using      (org_id = keel_current_org_id())
  with check (org_id = keel_current_org_id());

create policy environments_org_isolation on environments
  as permissive for all to public
  using      (org_id = keel_current_org_id())
  with check (org_id = keel_current_org_id());

create policy api_keys_org_isolation on api_keys
  as permissive for all to public
  using      (org_id = keel_current_org_id())
  with check (org_id = keel_current_org_id());
