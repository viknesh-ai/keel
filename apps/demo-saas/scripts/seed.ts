import { hashPassword } from "../src/auth.js";
import { pool, query } from "../src/db.js";

/**
 * Deterministic seed. ~200 customers with a login-recency spread chosen so the
 * demo query — "customers who haven't logged in for 30 days" — returns a set
 * that is neither empty nor everything, because both of those make the demo
 * prove nothing.
 *
 * Deterministic on purpose: the same data every run means an evaluation
 * fixture recorded today still means something next month. A random seed would
 * make eval results drift for reasons unrelated to the agent.
 */

// mulberry32 — small, fast, and reproducible across platforms.
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = rng(20260813);
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const between = (min: number, max: number): number => min + Math.floor(random() * (max - min + 1));

const INDIAN_FIRST = [
  "Arun",
  "Priya",
  "Vikram",
  "Ananya",
  "Rohit",
  "Meera",
  "Karthik",
  "Divya",
  "Sanjay",
  "Kavya",
  "Aditya",
  "Sneha",
  "Rajesh",
  "Lakshmi",
  "Nikhil",
  "Pooja",
  "Suresh",
  "Ritu",
  "Manish",
  "Aisha",
  "Deepak",
  "Nandini",
  "Harish",
  "Swathi",
  "Varun",
  "Ishita",
  "Gopal",
  "Trisha",
  "Aravind",
  "Neha",
];
const INDIAN_LAST = [
  "Sharma",
  "Iyer",
  "Reddy",
  "Nair",
  "Patel",
  "Menon",
  "Rao",
  "Krishnan",
  "Gupta",
  "Desai",
  "Pillai",
  "Chandran",
  "Banerjee",
  "Kulkarni",
  "Subramanian",
  "Joshi",
  "Verma",
  "Naidu",
];
const INTL_FIRST = [
  "Sofia",
  "Liam",
  "Yuki",
  "Mateo",
  "Amara",
  "Lukas",
  "Chen",
  "Fatima",
  "Noah",
  "Elena",
  "Omar",
  "Ingrid",
  "Diego",
  "Hana",
  "Tomas",
  "Zara",
  "Andre",
  "Mei",
  "Jonas",
  "Leila",
];
const INTL_LAST = [
  "Almeida",
  "O'Connor",
  "Tanaka",
  "Rossi",
  "Okafor",
  "Müller",
  "Wang",
  "Haddad",
  "Nilsson",
  "Petrov",
  "Dubois",
  "Kim",
  "Silva",
  "Novak",
  "Andersson",
  "Costa",
];
const COMPANY_HEAD = [
  "Meridian",
  "Bluecrest",
  "Northgate",
  "Sundara",
  "Quanta",
  "Vellore",
  "Arclight",
  "Fernweh",
  "Kestrel",
  "Padma",
  "Ironwood",
  "Solstice",
  "Halcyon",
  "Trivandrum",
  "Vector",
  "Amberline",
  "Cobalt",
  "Sahyadri",
  "Lumen",
  "Brightfold",
];
const COMPANY_TAIL = [
  "Labs",
  "Systems",
  "Technologies",
  "Analytics",
  "Digital",
  "Works",
  "Group",
  "Retail",
];

const PLANS = ["free", "starter", "pro", "enterprise"] as const;
const PLAN_MRR: Record<(typeof PLANS)[number], number> = {
  free: 0,
  starter: 4_900,
  pro: 24_900,
  enterprise: 99_900,
};

const DAY = 86_400_000;
const now = Date.now();
const ago = (days: number) => new Date(now - days * DAY);

async function main(): Promise<void> {
  process.stdout.write("seeding Northwind Cloud…\n");

  await query(
    "truncate usage_events, orders, invoices, subscriptions, customers, sessions, staff restart identity cascade",
  );

  // ---- staff -------------------------------------------------------------
  // The password is published in the README. This is a demo whose whole point
  // is being logged into; a hidden credential would just be friction.
  const password = await hashPassword("northwind");
  const staff = [
    ["ops@northwind.example", "Priya Menon", "owner"],
    ["support@northwind.example", "Daniel Okafor", "support"],
    ["finance@northwind.example", "Hana Tanaka", "finance"],
    ["viewer@northwind.example", "Arjun Rao", "readonly"],
  ] as const;

  for (const [email, name, role] of staff) {
    await query("insert into staff (email, name, role, password_hash) values ($1, $2, $3, $4)", [
      email,
      name,
      role,
      password,
    ]);
  }

  // ---- customers ---------------------------------------------------------
  const COUNT = 200;
  const customerIds: string[] = [];
  let inactiveCount = 0;

  for (let i = 0; i < COUNT; i += 1) {
    const indian = random() < 0.55;
    const first = indian ? pick(INDIAN_FIRST) : pick(INTL_FIRST);
    const last = indian ? pick(INDIAN_LAST) : pick(INTL_LAST);
    const company = `${pick(COMPANY_HEAD)} ${pick(COMPANY_TAIL)}`;
    const country = indian ? "IN" : pick(["US", "GB", "DE", "SG", "AE", "BR", "JP", "SE"]);

    const signedUpDays = between(20, 900);

    // The spread that makes the demo query meaningful: about a third are
    // inactive, and a few have never logged in at all.
    // Every branch is clamped to the signup date: a login can never predate the
    // account, and the CHECK constraint on customers enforces it besides.
    const roll = random();
    let lastLogin: Date | null;
    if (roll < 0.06) {
      lastLogin = null;
    } else if (roll < 0.36 && signedUpDays > 32) {
      lastLogin = ago(between(31, signedUpDays));
    } else {
      lastLogin = ago(between(0, Math.min(29, signedUpDays)));
    }
    if (lastLogin === null || now - lastLogin.getTime() > 30 * DAY) inactiveCount += 1;

    const status =
      lastLogin === null
        ? pick(["trial", "suspended"] as const)
        : pick(["active", "active", "active", "trial", "churned"] as const);

    const rows = await query<{ id: string }>(
      `insert into customers (name, email, company, country, last_login_at, signed_up_at, status)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [
        `${first} ${last}`,
        `${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g, "")}${i}@${company
          .split(" ")[0]
          ?.toLowerCase()}.example`,
        company,
        country,
        lastLogin,
        ago(signedUpDays),
        status,
      ],
    );

    const id = rows[0]?.id;
    if (id === undefined) throw new Error("customer insert returned no id");
    customerIds.push(id);

    // ---- subscription ----------------------------------------------------
    if (status !== "churned") {
      const plan = pick(PLANS);
      const interval = random() < 0.3 ? "annual" : "monthly";
      const currency = country === "IN" ? "INR" : pick(["USD", "EUR", "GBP"] as const);
      const base = PLAN_MRR[plan];
      // INR pricing is not a converted USD price — it is priced for the market,
      // which is what a real Indian SaaS does.
      const mrr = currency === "INR" ? base * 20 : base;

      await query(
        `insert into subscriptions
           (customer_id, plan, billing_interval, status, mrr_minor, currency,
            started_at, current_period_end)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          plan,
          interval,
          status === "trial" ? "trialing" : random() < 0.08 ? "past_due" : "active",
          interval === "annual" ? Math.round(mrr * 0.833) : mrr,
          currency,
          ago(signedUpDays),
          new Date(now + between(1, 30) * DAY),
        ],
      );

      // ---- invoices ------------------------------------------------------
      const invoiceCount = between(1, 6);
      for (let n = 0; n < invoiceCount; n += 1) {
        const issued = ago(between(1, 400));
        const paid = random() < 0.78;
        await query(
          `insert into invoices
             (customer_id, number, amount_minor, currency, status, issued_at, due_at, paid_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            id,
            `NW-${String(i).padStart(4, "0")}-${String(n).padStart(3, "0")}`,
            mrr === 0 ? 0 : mrr + between(0, 500) * 100,
            currency,
            paid ? "paid" : pick(["open", "open", "uncollectible"] as const),
            issued,
            new Date(issued.getTime() + 14 * DAY),
            paid ? new Date(issued.getTime() + between(1, 13) * DAY) : null,
          ],
        );
      }

      // ---- orders --------------------------------------------------------
      for (let n = 0; n < between(0, 3); n += 1) {
        const placed = ago(between(1, 300));
        const fulfilled = random() < 0.8;
        await query(
          `insert into orders
             (customer_id, reference, amount_minor, currency, status, placed_at, fulfilled_at)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            id,
            `ORD-${String(i).padStart(4, "0")}-${n}`,
            between(1, 40) * 10_000,
            currency,
            fulfilled ? "fulfilled" : pick(["pending", "refunded", "cancelled"] as const),
            placed,
            fulfilled ? new Date(placed.getTime() + between(1, 5) * DAY) : null,
          ],
        );
      }

      // ---- usage ---------------------------------------------------------
      for (const metric of ["api_calls", "seats", "storage_gb", "exports"] as const) {
        for (let d = 0; d < 30; d += 3) {
          await query(
            "insert into usage_events (customer_id, metric, quantity, occurred_at) values ($1, $2, $3, $4)",
            [
              id,
              metric,
              metric === "api_calls"
                ? between(50, 5000)
                : metric === "seats"
                  ? between(1, 40)
                  : between(0, 90),
              ago(d),
            ],
          );
        }
      }
    }
  }

  const counts = await query<{ table_name: string; n: string }>(`
    select 'customers' as table_name, count(*)::text as n from customers
    union all select 'subscriptions', count(*)::text from subscriptions
    union all select 'invoices', count(*)::text from invoices
    union all select 'orders', count(*)::text from orders
    union all select 'usage_events', count(*)::text from usage_events
    union all select 'staff', count(*)::text from staff
    order by table_name
  `);

  for (const row of counts) process.stdout.write(`  ${row.table_name.padEnd(14)} ${row.n}\n`);
  process.stdout.write(`  inactive >30d  ${inactiveCount} of ${COUNT}\n`);

  await pool.end();
}

await main();
