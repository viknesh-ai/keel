/** Row shapes and the row → wire mappings. One place, so responses cannot drift. */

export type CustomerRow = {
  id: string;
  name: string;
  email: string;
  company: string;
  country: string;
  last_login_at: Date | null;
  signed_up_at: Date;
  status: string;
  plan?: string | null;
};

export type SubscriptionRow = {
  id: string;
  customer_id: string;
  plan: string;
  billing_interval: string;
  status: string;
  mrr_minor: string;
  currency: string;
  started_at: Date;
  current_period_end: Date;
  cancel_at_period_end: boolean;
  cancelled_at: Date | null;
};

export type InvoiceRow = {
  id: string;
  customer_id: string;
  number: string;
  amount_minor: string;
  currency: string;
  status: string;
  issued_at: Date;
  due_at: Date;
  paid_at: Date | null;
};

export type OrderRow = {
  id: string;
  customer_id: string;
  reference: string;
  amount_minor: string;
  currency: string;
  status: string;
  placed_at: Date;
  fulfilled_at: Date | null;
};

export const money = (amount_minor: number, currency: string) => ({ amount_minor, currency });

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

export const toCustomer = (row: CustomerRow) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  company: row.company,
  country: row.country,
  status: row.status,
  signed_up_at: row.signed_up_at.toISOString(),
  last_login_at: iso(row.last_login_at),
  plan: row.plan ?? null,
});

export const toSubscription = (row: SubscriptionRow) => ({
  id: row.id,
  customer_id: row.customer_id,
  plan: row.plan,
  billing_interval: row.billing_interval,
  status: row.status,
  mrr: money(Number(row.mrr_minor), row.currency),
  started_at: row.started_at.toISOString(),
  current_period_end: row.current_period_end.toISOString(),
  cancel_at_period_end: row.cancel_at_period_end,
  cancelled_at: iso(row.cancelled_at),
});

export const toInvoice = (row: InvoiceRow) => ({
  id: row.id,
  customer_id: row.customer_id,
  number: row.number,
  amount: money(Number(row.amount_minor), row.currency),
  status: row.status,
  issued_at: row.issued_at.toISOString(),
  due_at: row.due_at.toISOString(),
  paid_at: iso(row.paid_at),
});

export const toOrder = (row: OrderRow) => ({
  id: row.id,
  customer_id: row.customer_id,
  reference: row.reference,
  amount: money(Number(row.amount_minor), row.currency),
  status: row.status,
  placed_at: row.placed_at.toISOString(),
  fulfilled_at: iso(row.fulfilled_at),
});

export function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return 25;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
}

/**
 * Keyset pagination, not offset. Offset pagination silently skips or repeats
 * rows when the underlying set changes between pages, which for an agent
 * walking a customer list means a quietly wrong answer.
 */
export function encodeCursor(timestamp: Date, id: string): string {
  return Buffer.from(`${timestamp.toISOString()}|${id}`).toString("base64url");
}

export function decodeCursor(raw: string | undefined): { signedUpAt: string; id: string } | null {
  if (raw === undefined) return null;
  try {
    const [signedUpAt, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
    if (signedUpAt === undefined || id === undefined) return null;
    if (Number.isNaN(Date.parse(signedUpAt))) return null;
    return { signedUpAt, id };
  } catch {
    return null;
  }
}
