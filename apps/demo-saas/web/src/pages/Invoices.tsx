import { Badge, EmptyState, Select, Skeleton } from "@keel/ui";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, formatMoney, type Invoice } from "../api.ts";

const TONE = {
  paid: "success",
  open: "warning",
  draft: "neutral",
  void: "neutral",
  uncollectible: "danger",
} as const;

export default function InvoicesPage() {
  const [params, setParams] = useSearchParams();
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const customerId = params.get("customer_id") ?? undefined;
  const status = params.get("status") ?? undefined;

  useEffect(() => {
    const q: Record<string, string> = { limit: "50" };
    if (customerId !== undefined) q.customer_id = customerId;
    if (status !== undefined) q.status = status;

    setInvoices(null);
    api
      .invoices(q)
      .then((page) => setInvoices(page.data))
      .catch((e: Error) => setError(e.message));
  }, [customerId, status]);

  return (
    <>
      <h1 className="nw-title">Invoices</h1>

      <div className="nw-filters">
        <Select
          label="Invoice status"
          placeholder="Any status"
          value={status}
          onValueChange={(v) => {
            const next = new URLSearchParams(params);
            next.set("status", v);
            setParams(next);
          }}
          options={[
            { value: "open", label: "open" },
            { value: "paid", label: "paid" },
            { value: "uncollectible", label: "uncollectible" },
          ]}
        />
        {customerId !== undefined ? (
          <Badge tone="info" mono>
            {customerId}
          </Badge>
        ) : null}
      </div>

      {error !== null ? <EmptyState title="Could not load invoices" description={error} /> : null}
      {invoices === null && error === null ? <Skeleton height="200px" radius="md" /> : null}

      {invoices !== null && invoices.length === 0 ? (
        <EmptyState title="No invoices match" description="Try a different status." />
      ) : null}

      {invoices !== null && invoices.length > 0 ? (
        <table className="nw-table">
          <thead>
            <tr>
              <th>Number</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Issued</th>
              <th>Paid</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => (
              <tr key={inv.id}>
                <td className="k-mono">{inv.number}</td>
                <td className="k-mono">{formatMoney(inv.amount)}</td>
                <td>
                  <Badge tone={TONE[inv.status as keyof typeof TONE] ?? "neutral"}>
                    {inv.status}
                  </Badge>
                </td>
                <td className="k-mono">{new Date(inv.issued_at).toLocaleDateString()}</td>
                <td className="k-mono">
                  {inv.paid_at === null ? "—" : new Date(inv.paid_at).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}
