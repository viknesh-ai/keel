import { Badge, Button, EmptyState, Input, Select, Skeleton, StatusDot } from "@keel/ui";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Customer, daysSince } from "../api.ts";

const STATUS_TONE = {
  active: "success",
  trial: "info",
  churned: "danger",
  suspended: "warning",
} as const;

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>();
  const [inactiveOnly, setInactiveOnly] = useState(false);

  useEffect(() => {
    const params: Record<string, string> = { limit: "50" };
    if (search.trim() !== "") params.q = search.trim();
    if (status !== undefined) params.status = status;
    if (inactiveOnly) params.inactive_days = "30";

    let cancelled = false;
    setCustomers(null);
    api
      .customers(params)
      .then((page) => {
        if (!cancelled) setCustomers(page.data);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [search, status, inactiveOnly]);

  return (
    <>
      <h1 className="nw-title">Customers</h1>

      <div className="nw-filters">
        <Input
          aria-label="Search customers"
          placeholder="Name, company or email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          label="Status"
          placeholder="Any status"
          value={status}
          onValueChange={setStatus}
          options={[
            { value: "active", label: "active" },
            { value: "trial", label: "trial" },
            { value: "churned", label: "churned" },
            { value: "suspended", label: "suspended" },
          ]}
        />
        <Button
          variant={inactiveOnly ? "primary" : "secondary"}
          aria-pressed={inactiveOnly}
          onClick={() => setInactiveOnly((v) => !v)}
        >
          Inactive 30+ days
        </Button>
      </div>

      {error !== null ? <EmptyState title="Could not load customers" description={error} /> : null}

      {customers === null && error === null ? (
        <div className="nw-stack">
          <Skeleton height="32px" />
          <Skeleton height="32px" />
          <Skeleton height="32px" />
        </div>
      ) : null}

      {customers !== null && customers.length === 0 ? (
        <EmptyState title="No customers match" description="Try clearing a filter." />
      ) : null}

      {customers !== null && customers.length > 0 ? (
        <table className="nw-table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Company</th>
              <th>Plan</th>
              <th>Status</th>
              <th>Last login</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => {
              const days = daysSince(c.last_login_at);
              return (
                <tr key={c.id}>
                  <td>
                    <Link className="nw-link" to={`/customers/${c.id}`}>
                      {c.name}
                    </Link>
                    <div className="nw-sub">{c.email}</div>
                  </td>
                  <td>
                    {c.company}
                    <div className="nw-sub">{c.country}</div>
                  </td>
                  <td>
                    {c.plan === null ? <span className="nw-sub">—</span> : <Badge>{c.plan}</Badge>}
                  </td>
                  <td>
                    <Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge>
                  </td>
                  <td>
                    {days === null ? (
                      <StatusDot status="warning" label="Never logged in" showLabel />
                    ) : (
                      <span className={days > 30 ? "nw-stale k-mono" : "k-mono"}>{days}d ago</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </>
  );
}
