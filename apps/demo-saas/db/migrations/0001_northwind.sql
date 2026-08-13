-- 0001_northwind.sql — Northwind Cloud.
--
-- This is the demo product's *own* schema, in its own database. It is not part
-- of Keel and deliberately shares nothing with it: Northwind is the customer,
-- Keel is the vendor, and blurring that in the fixture would hide exactly the
-- boundary the security tests exist to probe.
--
-- The runner wraps this file in a transaction. No BEGIN/COMMIT.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Staff accounts. These are Northwind's own employees, who log into Northwind.
-- They are NOT Keel dashboard users, and the distinction matters: an identity
-- token minted here is what Keel later verifies against Northwind's JWKS.
-- ---------------------------------------------------------------------------

create table staff (
  id             text primary key default 'stf_' || encode(gen_random_bytes(12), 'hex'),
  email          text not null,
  name           text not null,
  role           text not null check (role in ('owner', 'support', 'finance', 'readonly')),
  password_hash  text not null,
  created_at     timestamptz not null default now()
);

create unique index staff_email_key on staff (lower(email));

create table sessions (
  token       text primary key,
  staff_id    text not null references staff (id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

create index sessions_staff_id_idx on sessions (staff_id);
create index sessions_expires_at_idx on sessions (expires_at);

-- ---------------------------------------------------------------------------
-- The business
-- ---------------------------------------------------------------------------

create table customers (
  id              text primary key default 'cus_' || encode(gen_random_bytes(12), 'hex'),
  name            text not null,
  email           text not null,
  company         text not null,
  country         text not null check (length(country) = 2),
  -- The whole point of the demo query "customers who haven't logged in for 30
  -- days". Nullable: a customer may never have logged in at all.
  last_login_at   timestamptz,
  signed_up_at    timestamptz not null default now(),
  status          text not null check (status in ('active', 'trial', 'churned', 'suspended')),
  created_at      timestamptz not null default now(),
  -- A customer cannot have logged in before they existed. Enforced here rather
  -- than trusted to the seed generator, because "last login predates signup" is
  -- the kind of nonsense that makes a demo look untrustworthy and would quietly
  -- poison any evaluation fixture built from this data.
  constraint customers_login_after_signup
    check (last_login_at is null or last_login_at >= signed_up_at)
);

create unique index customers_email_key on customers (lower(email));
create index customers_last_login_at_idx on customers (last_login_at);
create index customers_status_idx on customers (status);

create table subscriptions (
  id                   text primary key default 'sub_' || encode(gen_random_bytes(12), 'hex'),
  customer_id          text not null references customers (id) on delete cascade,
  plan                 text not null check (plan in ('free', 'starter', 'pro', 'enterprise')),
  -- Annual plans are the branch every real cancellation flow trips over, and
  -- the subscription-cancellation workflow in slice 6 depends on this existing.
  billing_interval     text not null check (billing_interval in ('monthly', 'annual')),
  status               text not null
                         check (status in ('active', 'trialing', 'past_due', 'cancelled')),
  mrr_minor            bigint not null check (mrr_minor >= 0),
  currency             text not null check (currency in ('INR', 'USD', 'EUR', 'GBP')),
  started_at           timestamptz not null,
  current_period_end   timestamptz not null,
  cancel_at_period_end boolean not null default false,
  cancelled_at         timestamptz,
  created_at           timestamptz not null default now()
);

create index subscriptions_customer_id_idx on subscriptions (customer_id);
create index subscriptions_status_idx on subscriptions (status);

create table invoices (
  id            text primary key default 'inv_' || encode(gen_random_bytes(12), 'hex'),
  customer_id   text not null references customers (id) on delete cascade,
  number        text not null unique,
  -- Minor units throughout. Storing money as a float is how you end up with a
  -- ledger that does not balance.
  amount_minor  bigint not null check (amount_minor >= 0),
  currency      text not null check (currency in ('INR', 'USD', 'EUR', 'GBP')),
  status        text not null check (status in ('draft', 'open', 'paid', 'void', 'uncollectible')),
  issued_at     timestamptz not null,
  due_at        timestamptz not null,
  paid_at       timestamptz,
  created_at    timestamptz not null default now()
);

create index invoices_customer_id_idx on invoices (customer_id);
create index invoices_status_idx on invoices (status);
create index invoices_issued_at_idx on invoices (issued_at desc);

create table orders (
  id             text primary key default 'ord_' || encode(gen_random_bytes(12), 'hex'),
  customer_id    text not null references customers (id) on delete cascade,
  reference      text not null unique,
  amount_minor   bigint not null check (amount_minor >= 0),
  currency       text not null check (currency in ('INR', 'USD', 'EUR', 'GBP')),
  status         text not null check (status in ('pending', 'fulfilled', 'refunded', 'cancelled')),
  placed_at      timestamptz not null,
  fulfilled_at   timestamptz,
  created_at     timestamptz not null default now()
);

create index orders_customer_id_idx on orders (customer_id);
create index orders_placed_at_idx on orders (placed_at desc);

create table usage_events (
  id           bigserial primary key,
  customer_id  text not null references customers (id) on delete cascade,
  metric       text not null check (metric in ('api_calls', 'seats', 'storage_gb', 'exports')),
  quantity     integer not null check (quantity >= 0),
  occurred_at  timestamptz not null
);

create index usage_events_customer_metric_idx on usage_events (customer_id, metric, occurred_at desc);
