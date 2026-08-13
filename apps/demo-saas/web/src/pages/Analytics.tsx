import { EmptyState, KeyValue, Skeleton } from "@keel/ui";
import { useEffect, useState } from "react";
import { type AnalyticsSummary, api, formatMoney } from "../api.ts";

export default function AnalyticsPage() {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .analytics()
      .then(setSummary)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error !== null) return <EmptyState title="Could not load analytics" description={error} />;
  if (summary === null) return <Skeleton height="200px" radius="md" />;

  const byStatus = summary.customers_by_status;
  const total = byStatus.active + byStatus.trial + byStatus.churned + byStatus.suspended;

  return (
    <>
      <h1 className="nw-title">Analytics</h1>

      <div className="nw-stats">
        <div className="nw-stat">
          <span className="nw-stat__label">Total MRR</span>
          <span className="nw-stat__value k-mono">{formatMoney(summary.total_mrr)}</span>
          <span className="nw-sub">normalised to INR at fixed demo rates</span>
        </div>
        <div className="nw-stat">
          <span className="nw-stat__label">Open invoices</span>
          <span className="nw-stat__value k-mono">{formatMoney(summary.open_invoice_value)}</span>
        </div>
        <div className="nw-stat">
          <span className="nw-stat__label">Inactive 30+ days</span>
          <span className="nw-stat__value k-mono">
            {summary.inactive_30d} / {total}
          </span>
        </div>
      </div>

      <h2 className="nw-heading">Customers by status</h2>
      <KeyValue
        items={[
          { key: "active", value: String(byStatus.active) },
          { key: "trial", value: String(byStatus.trial) },
          { key: "churned", value: String(byStatus.churned) },
          { key: "suspended", value: String(byStatus.suspended) },
        ]}
      />
    </>
  );
}
