-- 0005_approvals.sql — approval records (doc 03 §C4).
--
-- An approval is a persisted record, not a UI state. That distinction is the
-- whole session: the run suspends *durably*, so an approval survives reload,
-- redeploy and hours of delay, and a restarted process resumes the run rather
-- than losing it.
--
-- The runner wraps this file in a transaction. No BEGIN/COMMIT.

create table approvals (
  id               text primary key default keel_id('apr')
                     check (id ~ '^apr_[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id           text not null,
  run_id           text not null,
  step_id          text,
  tool_version_id  text not null,
  tool             text not null,
  args             jsonb not null,
  -- Binds the approval to the exact arguments that were shown to the approver.
  -- Without this an approved call could be re-executed with different values,
  -- which would make the approval meaningless (doc 03 §C4, threat-model §T9).
  args_sha256      text not null check (args_sha256 ~ '^[a-f0-9]{64}$'),
  risk             text not null check (risk in ('read', 'low', 'high', 'critical')),
  -- `confirm` is the asking user; `approve` is a *different* principal holding
  -- an approval permission. These are genuinely different controls and the
  -- schema keeps them apart: "the user clicked yes" is not an authorization
  -- control when the user is the attacker.
  mode             text not null check (mode in ('confirm', 'approve')),
  requested_by     text,
  decide_by_role   text,
  state            text not null default 'pending'
                     check (state in ('pending', 'approved', 'rejected', 'expired', 'consumed')),
  requested_at     timestamptz not null default now(),
  expires_at       timestamptz not null,
  decided_by       text,
  decided_at       timestamptz,
  reason           text,
  -- Single-use. Set when the approved call actually executes; a second attempt
  -- finds the row already consumed.
  consumed_at      timestamptz,
  foreign key (run_id, org_id) references runs (id, org_id) on delete cascade,
  unique (id, org_id),
  -- A decision must record who made it. A row that is approved by nobody is an
  -- audit trail that cannot answer the only question it exists for.
  constraint approvals_decision_is_attributed
    check (state not in ('approved', 'rejected') or (decided_by is not null and decided_at is not null)),
  -- `approve` mode requires a role to decide; `confirm` does not.
  constraint approvals_approve_mode_has_role
    check (mode <> 'approve' or decide_by_role is not null)
);

create index approvals_org_id_idx on approvals (org_id);
create index approvals_run_idx on approvals (run_id);
-- The sweep reads this: pending approvals whose deadline has passed.
create index approvals_pending_expiry_idx on approvals (expires_at) where state = 'pending';

comment on column approvals.args_sha256 is
  'sha256 over the canonical arguments shown to the approver. Bound into the action token so an approved call cannot run with different arguments.';

grant select, insert, update on approvals to keel_app;

alter table approvals enable row level security;
alter table approvals force  row level security;

create policy approvals_org_isolation on approvals
  as permissive for all to public
  using      (org_id = keel_current_org_id())
  with check (org_id = keel_current_org_id());
