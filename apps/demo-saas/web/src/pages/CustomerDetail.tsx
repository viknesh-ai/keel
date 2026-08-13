import { Badge, Button, EmptyState, KeyValue, Skeleton } from "@keel/ui";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type CustomerDetail, formatMoney } from "../api.ts";

export default function CustomerDetailPage() {
  const { customerId } = useParams<{ customerId: string }>();
  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (customerId === undefined) return;
    api
      .customer(customerId)
      .then(setCustomer)
      .catch((e: Error) => setError(e.message));
  }, [customerId]);

  if (error !== null) return <EmptyState title="Could not load customer" description={error} />;
  if (customer === null) return <Skeleton height="240px" radius="md" />;

  const sub = customer.subscription;

  return (
    <>
      <Link className="nw-link nw-back" to="/customers">
        ← Customers
      </Link>
      <h1 className="nw-title">{customer.name}</h1>

      <div className="nw-cols">
        <section>
          <h2 className="nw-heading">Account</h2>
          <KeyValue
            items={[
              { key: "Customer ID", value: customer.id },
              { key: "Email", value: customer.email },
              { key: "Company", value: customer.company, mono: false },
              { key: "Country", value: customer.country },
              { key: "Status", value: <Badge>{customer.status}</Badge>, mono: false },
              {
                key: "Signed up",
                value: new Date(customer.signed_up_at).toLocaleDateString(),
              },
              {
                key: "Last login",
                value:
                  customer.last_login_at === null
                    ? "never"
                    : new Date(customer.last_login_at).toLocaleDateString(),
              },
            ]}
          />
        </section>

        <section>
          <h2 className="nw-heading">Subscription</h2>
          {sub === null ? (
            <EmptyState title="No subscription" description="This customer has never subscribed." />
          ) : (
            <KeyValue
              items={[
                { key: "Plan", value: <Badge>{sub.plan}</Badge>, mono: false },
                { key: "Billing", value: sub.billing_interval },
                { key: "Status", value: sub.status },
                { key: "MRR", value: formatMoney(sub.mrr) },
                {
                  key: "Period ends",
                  value: new Date(sub.current_period_end).toLocaleDateString(),
                },
                {
                  key: "Cancelling",
                  value: sub.cancel_at_period_end ? "at period end" : "no",
                },
              ]}
            />
          )}

          <h2 className="nw-heading">Invoices</h2>
          <KeyValue
            items={[
              { key: "Paid to date", value: formatMoney(customer.invoice_totals.paid) },
              { key: "Currently open", value: formatMoney(customer.invoice_totals.open) },
            ]}
          />
          <div className="nw-actions">
            <Button asChild>
              <Link to={`/invoices?customer_id=${customer.id}`}>View invoices</Link>
            </Button>
          </div>
        </section>
      </div>
    </>
  );
}
