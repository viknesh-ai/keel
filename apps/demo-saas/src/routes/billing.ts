import type { FastifyInstance } from "fastify";
import { requireStaff } from "../auth.js";
import { query, queryOne } from "../db.js";
import { badRequest, notFound } from "../problem.js";
import {
  decodeCursor,
  encodeCursor,
  type InvoiceRow,
  money,
  type OrderRow,
  parseLimit,
  toInvoice,
  toOrder,
} from "./shared.js";

const INVOICE_STATUSES = ["draft", "open", "paid", "void", "uncollectible"];
const ORDER_STATUSES = ["pending", "fulfilled", "refunded", "cancelled"];
const CUSTOMER_ID = /^cus_[0-9a-f]{24}$/;

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/invoices", async (request, reply) => {
    if ((await requireStaff(request, reply)) === undefined) return;

    const q = request.query as Record<string, string | undefined>;
    const limit = parseLimit(q.limit);
    if (limit === null) return badRequest(reply, "limit must be between 1 and 100");

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (q.customer_id !== undefined) {
      if (!CUSTOMER_ID.test(q.customer_id)) {
        return badRequest(reply, "customer_id is not a customer identifier");
      }
      params.push(q.customer_id);
      conditions.push(`customer_id = $${params.length}`);
    }

    if (q.status !== undefined) {
      if (!INVOICE_STATUSES.includes(q.status)) {
        return badRequest(reply, "status is not a known invoice status");
      }
      params.push(q.status);
      conditions.push(`status = $${params.length}`);
    }

    const cursor = decodeCursor(q.cursor);
    if (q.cursor !== undefined && cursor === null) return badRequest(reply, "cursor is not valid");
    if (cursor !== null) {
      params.push(cursor.signedUpAt, cursor.id);
      conditions.push(`(issued_at, id) < ($${params.length - 1}::timestamptz, $${params.length})`);
    }

    const where = conditions.length === 0 ? "" : `where ${conditions.join(" and ")}`;
    params.push(limit + 1);

    const rows = await query<InvoiceRow>(
      `select * from invoices ${where} order by issued_at desc, id desc limit $${params.length}`,
      params,
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return reply.send({
      data: page.map(toInvoice),
      page: {
        has_more: hasMore,
        next_cursor: hasMore && last !== undefined ? encodeCursor(last.issued_at, last.id) : null,
      },
    });
  });

  app.get("/api/v1/invoices/:invoiceId", async (request, reply) => {
    if ((await requireStaff(request, reply)) === undefined) return;

    const { invoiceId } = request.params as { invoiceId: string };
    const row = await queryOne<InvoiceRow>("select * from invoices where id = $1", [invoiceId]);
    if (row === undefined) return notFound(reply, "invoice");

    return reply.send(toInvoice(row));
  });

  app.get("/api/v1/orders", async (request, reply) => {
    if ((await requireStaff(request, reply)) === undefined) return;

    const q = request.query as Record<string, string | undefined>;
    const limit = parseLimit(q.limit);
    if (limit === null) return badRequest(reply, "limit must be between 1 and 100");

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (q.customer_id !== undefined) {
      if (!CUSTOMER_ID.test(q.customer_id)) {
        return badRequest(reply, "customer_id is not a customer identifier");
      }
      params.push(q.customer_id);
      conditions.push(`customer_id = $${params.length}`);
    }

    if (q.status !== undefined) {
      if (!ORDER_STATUSES.includes(q.status)) {
        return badRequest(reply, "status is not a known order status");
      }
      params.push(q.status);
      conditions.push(`status = $${params.length}`);
    }

    const cursor = decodeCursor(q.cursor);
    if (q.cursor !== undefined && cursor === null) return badRequest(reply, "cursor is not valid");
    if (cursor !== null) {
      params.push(cursor.signedUpAt, cursor.id);
      conditions.push(`(placed_at, id) < ($${params.length - 1}::timestamptz, $${params.length})`);
    }

    const where = conditions.length === 0 ? "" : `where ${conditions.join(" and ")}`;
    params.push(limit + 1);

    const rows = await query<OrderRow>(
      `select * from orders ${where} order by placed_at desc, id desc limit $${params.length}`,
      params,
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return reply.send({
      data: page.map(toOrder),
      page: {
        has_more: hasMore,
        next_cursor: hasMore && last !== undefined ? encodeCursor(last.placed_at, last.id) : null,
      },
    });
  });

  app.get("/api/v1/analytics/summary", async (request, reply) => {
    if ((await requireStaff(request, reply)) === undefined) return;

    const byStatus = await query<{ status: string; count: string }>(
      "select status, count(*)::text as count from customers group by status",
    );
    const counts = { active: 0, trial: 0, churned: 0, suspended: 0 };
    for (const row of byStatus) {
      if (row.status in counts) counts[row.status as keyof typeof counts] = Number(row.count);
    }

    // Normalised to INR at fixed demo rates. Real FX belongs in a rates service;
    // hard-coding it here keeps the demo deterministic, and the docs say so
    // rather than implying these are live rates.
    const mrr = await queryOne<{ total: string }>(
      `select coalesce(sum(
                mrr_minor * case currency
                  when 'INR' then 1.0 when 'USD' then 83.0
                  when 'EUR' then 90.0 when 'GBP' then 105.0 end
              ), 0)::bigint::text as total
         from subscriptions where status in ('active', 'trialing')`,
    );

    const open = await queryOne<{ total: string }>(
      `select coalesce(sum(
                amount_minor * case currency
                  when 'INR' then 1.0 when 'USD' then 83.0
                  when 'EUR' then 90.0 when 'GBP' then 105.0 end
              ), 0)::bigint::text as total
         from invoices where status = 'open'`,
    );

    const inactive = await queryOne<{ count: string }>(
      `select count(*)::text as count from customers
        where last_login_at is null or last_login_at < now() - interval '30 days'`,
    );

    return reply.send({
      customers_by_status: counts,
      total_mrr: money(Number(mrr?.total ?? 0), "INR"),
      open_invoice_value: money(Number(open?.total ?? 0), "INR"),
      inactive_30d: Number(inactive?.count ?? 0),
      generated_at: new Date().toISOString(),
    });
  });
}
