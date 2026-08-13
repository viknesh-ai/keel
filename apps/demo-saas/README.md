# Northwind Cloud

The demo product Keel governs — a small B2B subscription business — and the
fixture the rest of the test suite runs against.

It is deliberately a *separate product*: its own database, its own staff
accounts, its own signing key. Northwind is the customer; Keel is the vendor.
Blurring that in the fixture would hide the boundary the security suite exists
to probe.

## Running it

```bash
docker compose up -d postgres          # from the repo root
pnpm --filter @keel/demo-saas db:migrate
pnpm --filter @keel/demo-saas db:seed
pnpm --filter @keel/demo-saas start    # API on :4000
pnpm --filter @keel/demo-saas dev:web  # UI on :4001
```

Sign in with any of these; the password is `northwind` for all of them. These
are demo credentials against demo data and are published on purpose — a hidden
password on a demo is friction with no security value.

| Email | Role | Can mutate |
|---|---|---|
| `ops@northwind.example` | owner | yes |
| `support@northwind.example` | support | yes |
| `finance@northwind.example` | finance | no |
| `viewer@northwind.example` | readonly | no |

## The API

The OpenAPI 3.1 specification is hand-written in `openapi.yaml` and served from
`/openapi.yaml`. It is the contract Keel imports to derive tool definitions, so
every operation has an `operationId`, a description written for tool selection
rather than for a docs page, and a complete response schema.

```bash
pnpm --filter @keel/demo-saas verify:operations
```

That script is the session's exit criterion. It checks every documented
operation against a running instance with real seeded data, asserts each one
rejects an anonymous caller with 401, and asserts the served spec is
byte-identical to the checked-in file.

Two auth modes, deliberately not blurred:

- **Session cookie** — the web UI, for a human at a browser.
- **Bearer JWT** — machine callers including Keel. EdDSA, verified against
  `/.well-known/jwks.json`. The asymmetry is the point: a verifier can check a
  token but cannot mint one, so a compromised control plane still cannot
  fabricate a staff identity.

## The data

200 customers, deterministic from a fixed seed so an evaluation fixture recorded
today still means something next month.

- Roughly a third have not logged in for over 30 days, and twelve have never
  logged in — enough for the demo query *"customers who haven't logged in for
  30 days"* to return a meaningful set rather than nothing or everything.
- Indian and international names in a realistic mix, with INR the most common
  billing currency alongside USD, EUR and GBP.
- INR prices are set for the market, not converted from USD. The ratio is not
  the exchange rate and that is not a bug.

## `docs/`

Real prose for later knowledge ingestion — refund policy, subscription policy,
pricing and an FAQ. Written to be answerable from, including the cases where the
answer is "no", because a policy document that only covers the happy path
teaches an agent nothing useful.
