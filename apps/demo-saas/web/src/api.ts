/** Typed client for the Northwind API. Mirrors openapi.yaml by hand — this is a
 *  demo product, and its own SDK generation is not what Keel is demonstrating. */

export type Money = { amount_minor: number; currency: string };
export type CustomerStatus = "active" | "trial" | "churned" | "suspended";
export type Plan = "free" | "starter" | "pro" | "enterprise";

export type Customer = {
  id: string;
  name: string;
  email: string;
  company: string;
  country: string;
  status: CustomerStatus;
  signed_up_at: string;
  last_login_at: string | null;
  plan: Plan | null;
};

export type Subscription = {
  id: string;
  customer_id: string;
  plan: Plan;
  billing_interval: "monthly" | "annual";
  status: string;
  mrr: Money;
  started_at: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
  cancelled_at: string | null;
};

export type CustomerDetail = Customer & {
  subscription: Subscription | null;
  invoice_totals: { paid: Money; open: Money };
};

export type Invoice = {
  id: string;
  customer_id: string;
  number: string;
  amount: Money;
  status: string;
  issued_at: string;
  due_at: string;
  paid_at: string | null;
};

export type Staff = { id: string; email: string; name: string; role: string };

export type AnalyticsSummary = {
  customers_by_status: Record<CustomerStatus, number>;
  total_mrr: Money;
  open_invoice_value: Money;
  inactive_30d: number;
  generated_at: string;
};

export type Page<T> = { data: T[]; page: { next_cursor: string | null; has_more: boolean } };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({ detail: response.statusText }));
    throw new ApiError(response.status, detail.detail ?? response.statusText);
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

export const api = {
  login: (email: string, password: string) =>
    request<Staff>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  me: () => request<Staff>("/api/auth/me"),
  customers: (params: Record<string, string>) =>
    request<Page<Customer>>(`/api/v1/customers?${new URLSearchParams(params)}`),
  customer: (id: string) => request<CustomerDetail>(`/api/v1/customers/${id}`),
  invoices: (params: Record<string, string>) =>
    request<Page<Invoice>>(`/api/v1/invoices?${new URLSearchParams(params)}`),
  analytics: () => request<AnalyticsSummary>("/api/v1/analytics/summary"),
};

const SYMBOL: Record<string, string> = { INR: "₹", USD: "$", EUR: "€", GBP: "£" };

/** Minor units to a display string. Never does arithmetic on floats. */
export function formatMoney(m: Money): string {
  const major = (m.amount_minor / 100).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return `${SYMBOL[m.currency] ?? `${m.currency} `}${major}`;
}

export function daysSince(iso: string | null): number | null {
  if (iso === null) return null;
  return Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
}
