import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InjectOptions } from "fastify";
import { parse } from "yaml";
import { pool } from "../src/db.js";
import { build } from "../src/server.js";

/**
 * Every operationId in the spec must be reachable — the session 1.1 exit
 * criterion.
 *
 * "Reachable" means the route exists and behaves: it is exercised with real
 * credentials against real seeded data, and a 404 or 405 is a failure. A check
 * that only asserted the path string appears somewhere in the source would pass
 * for a route that was never registered, which is the failure this is for.
 *
 * Each operation is also called *without* credentials and must answer 401.
 * A documented operation that is accidentally public is exactly the kind of gap
 * a spec-conformance script should catch, not a security review six weeks later.
 */

const here = dirname(fileURLToPath(import.meta.url));
const spec = parse(readFileSync(join(here, "..", "openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, { operationId?: string }>>;
};

type Check = {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly requiresAuth: boolean;
  readonly body?: Record<string, unknown>;
  readonly headers?: Record<string, string>;
  readonly expect: readonly number[];
};

const app = await build();

// Real ids from the seeded database, so the checks exercise 200s rather than
// well-formed 404s.
const customer = await pool.query<{ id: string }>(
  "select c.id from customers c join subscriptions s on s.customer_id = c.id and s.status <> 'cancelled' limit 1",
);
const invoice = await pool.query<{ id: string }>("select id from invoices limit 1");
const customerId = customer.rows[0]?.id;
const invoiceId = invoice.rows[0]?.id;

if (customerId === undefined || invoiceId === undefined) {
  process.stderr.write("error: database is empty — run `pnpm --filter @keel/demo-saas db:seed`\n");
  process.exit(1);
}

// Log in the way the UI does, so the session path is what gets exercised.
const login = await app.inject({
  method: "POST",
  url: "/api/auth/login",
  payload: { email: "ops@northwind.example", password: "northwind" },
});

if (login.statusCode !== 200) {
  process.stderr.write(`error: login failed with ${login.statusCode}: ${login.body}\n`);
  process.exit(1);
}

const cookie = login.headers["set-cookie"];
const sessionCookie = Array.isArray(cookie) ? cookie[0] : cookie;
if (sessionCookie === undefined) {
  process.stderr.write("error: login returned no session cookie\n");
  process.exit(1);
}

const idem = { "idempotency-key": "verify-operations-0001" };

const CHECKS: readonly Check[] = [
  {
    operationId: "login",
    method: "POST",
    path: "/api/auth/login",
    requiresAuth: false,
    body: { email: "ops@northwind.example", password: "northwind" },
    expect: [200],
  },
  {
    operationId: "getCurrentStaff",
    method: "GET",
    path: "/api/auth/me",
    requiresAuth: true,
    expect: [200],
  },
  {
    operationId: "listCustomers",
    method: "GET",
    path: "/api/v1/customers?limit=5",
    requiresAuth: true,
    expect: [200],
  },
  {
    operationId: "getCustomer",
    method: "GET",
    path: `/api/v1/customers/${customerId}`,
    requiresAuth: true,
    expect: [200],
  },
  {
    operationId: "getSubscription",
    method: "GET",
    path: `/api/v1/customers/${customerId}/subscription`,
    requiresAuth: true,
    expect: [200],
  },
  {
    operationId: "changeSubscriptionPlan",
    method: "POST",
    path: `/api/v1/customers/${customerId}/subscription`,
    requiresAuth: true,
    body: { plan: "pro" },
    headers: idem,
    expect: [200],
  },
  {
    operationId: "cancelSubscription",
    method: "POST",
    path: `/api/v1/customers/${customerId}/subscription/cancel`,
    requiresAuth: true,
    body: { when: "period_end" },
    headers: idem,
    expect: [200],
  },
  {
    operationId: "listInvoices",
    method: "GET",
    path: "/api/v1/invoices?limit=5",
    requiresAuth: true,
    expect: [200],
  },
  {
    operationId: "getInvoice",
    method: "GET",
    path: `/api/v1/invoices/${invoiceId}`,
    requiresAuth: true,
    expect: [200],
  },
  {
    operationId: "listOrders",
    method: "GET",
    path: "/api/v1/orders?limit=5",
    requiresAuth: true,
    expect: [200],
  },
  {
    operationId: "getCustomerUsage",
    method: "GET",
    path: `/api/v1/customers/${customerId}/usage`,
    requiresAuth: true,
    expect: [200],
  },
  {
    operationId: "getAnalyticsSummary",
    method: "GET",
    path: "/api/v1/analytics/summary",
    requiresAuth: true,
    expect: [200],
  },
  // Last: it invalidates the session every other check depends on.
  {
    operationId: "logout",
    method: "POST",
    path: "/api/auth/logout",
    requiresAuth: true,
    expect: [204],
  },
];

// ---- 1. every documented operation has a check -----------------------------

const documented = new Set<string>();
for (const [, methods] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(methods)) {
    if (["get", "post", "put", "patch", "delete"].includes(method)) {
      if (operation.operationId === undefined) {
        process.stderr.write(`error: an operation has no operationId\n`);
        process.exit(1);
      }
      documented.add(operation.operationId);
    }
  }
}

const checked = new Set(CHECKS.map((c) => c.operationId));
const unchecked = [...documented].filter((id) => !checked.has(id));
const extra = [...checked].filter((id) => !documented.has(id));

let failures = 0;

if (unchecked.length > 0) {
  process.stderr.write(`error: documented but never exercised: ${unchecked.join(", ")}\n`);
  failures += unchecked.length;
}
if (extra.length > 0) {
  process.stderr.write(`error: exercised but not in the spec: ${extra.join(", ")}\n`);
  failures += extra.length;
}

// ---- 2. every operation is reachable and behaves ---------------------------

process.stdout.write(`checking ${CHECKS.length} operations against the spec\n`);

for (const check of CHECKS) {
  const options: InjectOptions = {
    method: check.method as "GET" | "POST",
    url: check.path,
    headers: { cookie: sessionCookie, ...(check.headers ?? {}) },
  };
  if (check.body !== undefined) options.payload = check.body;

  const response = await app.inject(options);
  const ok = check.expect.includes(response.statusCode);
  process.stdout.write(
    `  ${ok ? "ok  " : "FAIL"} ${check.operationId.padEnd(24)} ${check.method} ${check.path.split("?")[0]} → ${response.statusCode}\n`,
  );
  if (!ok) {
    failures += 1;
    process.stderr.write(
      `       expected ${check.expect.join(" or ")}; body: ${response.body.slice(0, 200)}\n`,
    );
  }
}

// ---- 3. authenticated operations reject anonymous callers ------------------

process.stdout.write("checking that authenticated operations reject anonymous callers\n");

for (const check of CHECKS.filter((c) => c.requiresAuth)) {
  const options: InjectOptions = {
    method: check.method as "GET" | "POST",
    url: check.path,
    headers: check.headers ?? {},
  };
  if (check.body !== undefined) options.payload = check.body;

  const response = await app.inject(options);
  const ok = response.statusCode === 401;
  if (!ok) {
    failures += 1;
    process.stderr.write(
      `  FAIL ${check.operationId} answered ${response.statusCode} without credentials, expected 401\n`,
    );
  }
}

if (failures === 0) process.stdout.write("  all authenticated operations returned 401\n");

// ---- 4. the served spec is the checked-in spec -----------------------------

const served = await app.inject({ method: "GET", url: "/openapi.yaml" });
if (served.statusCode !== 200) {
  process.stderr.write(`error: /openapi.yaml returned ${served.statusCode}\n`);
  failures += 1;
} else if (served.body !== readFileSync(join(here, "..", "openapi.yaml"), "utf8")) {
  process.stderr.write("error: the served spec differs from the checked-in file\n");
  failures += 1;
} else {
  process.stdout.write("  served spec matches the checked-in file\n");
}

await app.close();
await pool.end();

if (failures > 0) {
  process.stderr.write(`\n${failures} failure(s)\n`);
  process.exit(1);
}

process.stdout.write(`\nall ${documented.size} documented operations are reachable\n`);
