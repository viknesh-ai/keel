import type { FastifyInstance } from "fastify";
import { canMutate, requireStaff } from "../auth.js";
import { config } from "../config.js";
import { query, queryOne } from "../db.js";
import { badRequest, forbidden, notFound } from "../problem.js";
import {
  type CustomerRow,
  decodeCursor,
  encodeCursor,
  money,
  parseLimit,
  type SubscriptionRow,
  toCustomer,
  toSubscription,
} from "./shared.js";

const PLAN_MRR_MINOR: Record<string, number> = {
  free: 0,
  starter: 4_900,
  pro: 24_900,
  enterprise: 99_900,
};

export async function customerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/customers", async (request, reply) => {
    if ((await requireStaff(request, reply)) === undefined) return;

    const q = request.query as Record<string, string | undefined>;
    const limit = parseLimit(q.limit);
    if (limit === null) return badRequest(reply, "limit must be between 1 and 100");

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (q.status !== undefined) {
      if (!["active", "trial", "churned", "suspended"].includes(q.status)) {
        return badRequest(reply, "status is not a known customer status");
      }
      params.push(q.status);
      conditions.push(`c.status = $${params.length}`);
    }

    if (q.inactive_days !== undefined) {
      const days = Number(q.inactive_days);
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        return badRequest(reply, "inactive_days must be an integer between 1 and 3650");
      }
      params.push(days);
      // "Never logged in" counts as inactive. Omitting the NULL branch is the
      // bug that makes this filter quietly miss the worst-affected accounts.
      conditions.push(
        `(c.last_login_at is null or c.last_login_at < now() - ($${params.length} || ' days')::interval)`,
      );
    }

    if (q.plan !== undefined) {
      if (!["free", "starter", "pro", "enterprise"].includes(q.plan)) {
        return badRequest(reply, "plan is not a known plan");
      }
      params.push(q.plan);
      conditions.push(`s.plan = $${params.length}`);
    }

    if (q.q !== undefined && q.q.trim() !== "") {
      params.push(`%${q.q.trim()}%`);
      conditions.push(
        `(c.name ilike $${params.length} or c.company ilike $${params.length} or c.email ilike $${params.length})`,
      );
    }

    const cursor = decodeCursor(q.cursor);
    if (q.cursor !== undefined && cursor === null) {
      return badRequest(reply, "cursor is not valid");
    }
    if (cursor !== null) {
      params.push(cursor.signedUpAt, cursor.id);
      conditions.push(
        `(c.signed_up_at, c.id) < ($${params.length - 1}::timestamptz, $${params.length})`,
      );
    }

    const where = conditions.length === 0 ? "" : `where ${conditions.join(" and ")}`;
    params.push(limit + 1);

    const rows = await query<CustomerRow>(
      `select c.*, s.plan as plan
         from customers c
         left join subscriptions s
           on s.customer_id = c.id and s.status <> 'cancelled'
         ${where}
        order by c.signed_up_at desc, c.id desc
        limit $${params.length}`,
      params,
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return reply.send({
      data: page.map(toCustomer),
      page: {
        has_more: hasMore,
        next_cursor:
          hasMore && last !== undefined ? encodeCursor(last.signed_up_at, last.id) : null,
      },
    });
  });

  app.get("/api/v1/customers/:customerId", async (request, reply) => {
    if ((await requireStaff(request, reply)) === undefined) return;

    const { customerId } = request.params as { customerId: string };

    const customer = await queryOne<CustomerRow>(
      `select c.*, s.plan as plan
         from customers c
         left join subscriptions s
           on s.customer_id = c.id and s.status <> 'cancelled'
        where c.id = $1`,
      [customerId],
    );
    if (customer === undefined) return notFound(reply, "customer");

    const subscription = await queryOne<SubscriptionRow>(
      "select * from subscriptions where customer_id = $1 and status <> 'cancelled' limit 1",
      [customerId],
    );

    const totals = await query<{ status: string; total: string; currency: string }>(
      `select status, sum(amount_minor)::text as total, min(currency) as currency
         from invoices where customer_id = $1 group by status`,
      [customerId],
    );

    const paid = totals.find((t) => t.status === "paid");
    const open = totals.find((t) => t.status === "open");

    return reply.send({
      ...toCustomer(customer),
      subscription: subscription === undefined ? null : toSubscription(subscription),
      invoice_totals: {
        paid: money(Number(paid?.total ?? 0), paid?.currency ?? "INR"),
        open: money(Number(open?.total ?? 0), open?.currency ?? "INR"),
      },
    });
  });

  app.get("/api/v1/customers/:customerId/subscription", async (request, reply) => {
    if ((await requireStaff(request, reply)) === undefined) return;

    const { customerId } = request.params as { customerId: string };
    const row = await queryOne<SubscriptionRow>(
      "select * from subscriptions where customer_id = $1 and status <> 'cancelled' limit 1",
      [customerId],
    );
    if (row === undefined) return notFound(reply, "subscription");

    return reply.send(toSubscription(row));
  });

  app.post("/api/v1/customers/:customerId/subscription", async (request, reply) => {
    const staff = await requireStaff(request, reply);
    if (staff === undefined) return;
    if (!canMutate(staff)) return forbidden(reply, `role "${staff.role}" may not change plans`);

    if (request.headers["idempotency-key"] === undefined) {
      return badRequest(reply, "Idempotency-Key header is required for this mutation");
    }

    const { customerId } = request.params as { customerId: string };
    const body = request.body as { plan?: string; billing_interval?: string } | undefined;

    if (body?.plan === undefined || PLAN_MRR_MINOR[body.plan] === undefined) {
      return badRequest(reply, "plan must be one of free, starter, pro, enterprise");
    }
    if (
      body.billing_interval !== undefined &&
      !["monthly", "annual"].includes(body.billing_interval)
    ) {
      return badRequest(reply, "billing_interval must be monthly or annual");
    }

    const existing = await queryOne<SubscriptionRow>(
      "select * from subscriptions where customer_id = $1 and status <> 'cancelled' limit 1",
      [customerId],
    );
    if (existing === undefined) return notFound(reply, "subscription");

    const interval = body.billing_interval ?? existing.billing_interval;
    // Annual is billed up front at a discount; MRR is still the monthly figure,
    // because mixing the two is how ARR reports end up wrong.
    const monthly = PLAN_MRR_MINOR[body.plan] ?? 0;
    const mrr = interval === "annual" ? Math.round(monthly * 0.833) : monthly;

    const updated = await queryOne<SubscriptionRow>(
      `update subscriptions
          set plan = $1, billing_interval = $2, mrr_minor = $3
        where id = $4
        returning *`,
      [body.plan, interval, mrr, existing.id],
    );
    if (updated === undefined) return notFound(reply, "subscription");

    return reply.send(toSubscription(updated));
  });

  app.post("/api/v1/customers/:customerId/subscription/cancel", async (request, reply) => {
    const staff = await requireStaff(request, reply);
    if (staff === undefined) return;
    if (!canMutate(staff)) {
      return forbidden(reply, `role "${staff.role}" may not cancel subscriptions`);
    }

    if (request.headers["idempotency-key"] === undefined) {
      return badRequest(reply, "Idempotency-Key header is required for this mutation");
    }

    const { customerId } = request.params as { customerId: string };
    const body = request.body as { when?: string; reason?: string } | undefined;

    if (body?.when !== "period_end" && body?.when !== "immediately") {
      return badRequest(reply, "when must be period_end or immediately");
    }

    const existing = await queryOne<SubscriptionRow>(
      "select * from subscriptions where customer_id = $1 and status <> 'cancelled' limit 1",
      [customerId],
    );
    if (existing === undefined) return notFound(reply, "subscription");

    const updated =
      body.when === "immediately"
        ? await queryOne<SubscriptionRow>(
            `update subscriptions
                set status = 'cancelled', cancelled_at = now(), cancel_at_period_end = false
              where id = $1 returning *`,
            [existing.id],
          )
        : await queryOne<SubscriptionRow>(
            "update subscriptions set cancel_at_period_end = true where id = $1 returning *",
            [existing.id],
          );

    if (updated === undefined) return notFound(reply, "subscription");
    return reply.send(toSubscription(updated));
  });

  app.get("/api/v1/customers/:customerId/usage", async (request, reply) => {
    if ((await requireStaff(request, reply)) === undefined) return;

    const { customerId } = request.params as { customerId: string };
    const q = request.query as Record<string, string | undefined>;
    const days = q.days === undefined ? config.inactiveDays : Number(q.days);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return badRequest(reply, "days must be an integer between 1 and 365");
    }

    const exists = await queryOne<{ id: string }>("select id from customers where id = $1", [
      customerId,
    ]);
    if (exists === undefined) return notFound(reply, "customer");

    const rows = await query<{ metric: string; total: string }>(
      `select metric, sum(quantity)::text as total
         from usage_events
        where customer_id = $1 and occurred_at > now() - ($2 || ' days')::interval
        group by metric order by metric`,
      [customerId, days],
    );

    return reply.send({
      customer_id: customerId,
      window_days: days,
      metrics: rows.map((r) => ({ metric: r.metric, total: Number(r.total) })),
    });
  });
}
