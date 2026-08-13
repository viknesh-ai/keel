-- 0004_identity.sql — how Keel verifies the end user of a customer's product.
--
-- Reference: docs/architecture/04-workflows-and-data-model.md Part B, and
-- docs/architecture/03 §identity.
--
-- The runner wraps this file in a transaction. No BEGIN/COMMIT.

-- ---------------------------------------------------------------------------
-- identity_configs — per project, whose tokens we trust and how we check them.
-- ---------------------------------------------------------------------------

create table identity_configs (
  id                text primary key default keel_id('idc')
                      check (id ~ '^idc_[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id            text not null,
  project_id        text not null,
  issuer            text not null check (issuer ~ '^https://'),
  jwks_uri          text not null check (jwks_uri ~ '^https://'),
  algorithms        text[] not null default '{EdDSA,RS256,ES256}',
  audience          text not null,
  -- Symmetric signing means the verifier can also mint. That collapses the
  -- whole point of verifying against the customer's own IdP, so it is off by
  -- default and turning it on is a deliberate, visible act (CLAUDE.md rule 6).
  allow_symmetric   boolean not null default false,
  created_at        timestamptz not null default now(),
  foreign key (project_id, org_id) references projects (id, org_id) on delete cascade,
  unique (project_id),
  -- An empty algorithm list would accept whatever the token's header claimed,
  -- which is the classic JWT confusion attack.
  -- coalesce is load-bearing: array_length('{}', 1) is NULL, and a CHECK only
  -- fails on FALSE, so the bare comparison would have let the empty list past.
  constraint identity_configs_algorithms_not_empty
    check (coalesce(array_length(algorithms, 1), 0) >= 1),
  -- HS* only makes sense when symmetric signing was explicitly enabled.
  constraint identity_configs_symmetric_consistent
    check (allow_symmetric or not (algorithms && '{HS256,HS384,HS512}'))
);

create index identity_configs_org_id_idx on identity_configs (org_id);

comment on column identity_configs.jwks_uri is
  'The customer IdP''s public keys. Keel verifies against these and never holds a signing key for the customer.';

-- ---------------------------------------------------------------------------
-- end_user_identities — one row per subject we have seen.
--
-- Claims are NOT persisted (doc 04 §B1). Only a digest, for correlating the
-- same subject across runs. Storing the claims would mean holding the
-- customer's end-user PII in our database for no capability we actually need,
-- and would make a deletion request our problem rather than a no-op.
-- ---------------------------------------------------------------------------

create table end_user_identities (
  id              text primary key default keel_id('eui')
                    check (id ~ '^eui_[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id          text not null,
  project_id      text not null,
  subject         text not null check (length(subject) between 1 and 512),
  claims_digest   text not null check (claims_digest ~ '^[a-f0-9]{64}$'),
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  foreign key (project_id, org_id) references projects (id, org_id) on delete cascade,
  unique (project_id, subject),
  unique (id, org_id)
);

create index end_user_identities_org_id_idx on end_user_identities (org_id);
create index end_user_identities_last_seen_idx on end_user_identities (project_id, last_seen_at desc);

comment on column end_user_identities.claims_digest is
  'sha256 over the canonical claim set. Correlation only — the claims themselves are never stored.';

-- Now that the table exists, tie the run and conversation references to it.
alter table conversations
  add constraint conversations_identity_fk
  foreign key (identity_id, org_id) references end_user_identities (id, org_id) on delete set null;

alter table runs
  add constraint runs_identity_fk
  foreign key (identity_id, org_id) references end_user_identities (id, org_id) on delete set null;

-- ---------------------------------------------------------------------------
-- Grants and row level security
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on identity_configs    to keel_app;
grant select, insert, update         on end_user_identities to keel_app;

alter table identity_configs    enable row level security;
alter table identity_configs    force  row level security;
alter table end_user_identities enable row level security;
alter table end_user_identities force  row level security;

create policy identity_configs_org_isolation on identity_configs
  as permissive for all to public
  using      (org_id = keel_current_org_id())
  with check (org_id = keel_current_org_id());

create policy end_user_identities_org_isolation on end_user_identities
  as permissive for all to public
  using      (org_id = keel_current_org_id())
  with check (org_id = keel_current_org_id());
