# Subscription policy

_Last reviewed: 12 August 2026. Owner: Revenue Operations._

How plans, upgrades, downgrades and cancellations behave on Northwind Cloud.

## Plans

| Plan | Intended for | Seats | API calls / month |
|---|---|---|---|
| Free | Evaluation | 1 | 1,000 |
| Starter | Small teams | 5 | 50,000 |
| Pro | Growing teams | 25 | 500,000 |
| Enterprise | Custom | Unlimited | Negotiated |

Limits are soft. We do not cut off a customer mid-month for exceeding API calls;
we flag it and the overage appears on the next invoice. Hard cut-offs generate
support load and churn out of proportion to the revenue they protect.

## Billing intervals

Every paid plan is available monthly or annually. Annual is billed once up front
at roughly a 17% discount, which is why the MRR figure on an annual subscription
is the monthly-equivalent, not the amount charged. Reporting the charged amount
as MRR overstates monthly revenue by twelve times and it is a mistake that has
been made before.

## Upgrades

Upgrades take effect **immediately**. The customer is charged a prorated amount
for the remainder of the current period, and the new rate applies from the next
renewal. Access to the higher plan's limits is available as soon as the change
is made — waiting for the next period is a common source of "I paid and nothing
happened" tickets.

## Downgrades

Downgrades take effect **at the end of the current period**, not immediately.
The customer keeps what they paid for until it runs out. No refund is issued for
the difference; see the refund policy for the credit options.

If the customer is over the lower plan's seat limit at the point the downgrade
lands, the account is not blocked. Extra seats become read-only and Northwind
emails the account owner. Deleting a customer's users to enforce a limit is not
something we do automatically.

## Cancellation

Two forms, and the difference matters:

- **At period end** — the default. `cancel_at_period_end` is set, the customer
  keeps access until `current_period_end`, and nothing is charged again. This is
  reversible: the customer can un-cancel any time before the period ends.
- **Immediately** — access ends now and the subscription moves to `cancelled`.
  This is **not reversible** through the product. Restoring it means creating a
  new subscription, and any prorated remainder is handled as a refund case.

Support should default to period-end cancellation unless the customer explicitly
asks to lose access now. The immediate form exists for compliance situations and
for customers who need billing to stop for audit reasons.

### Annual mid-term

An annual subscription cancelled mid-term stops the next renewal. It does not
produce a refund of the unused months by default — see the refund policy. Offer
credit or a downgrade first; the retention rate on that conversation is high and
the alternative is a refund request that Finance will usually decline anyway.

## Past due

An invoice unpaid 14 days after issue moves the subscription to `past_due`. The
account keeps working. At 45 days it is suspended, and at 90 days the
subscription is cancelled and the data enters the 30-day deletion window
described in the FAQ.

Nothing in that sequence happens silently: each step sends an email to the
account owner and to any billing contact.

## Reactivation

A `cancelled` subscription can be reactivated within 30 days with its data
intact. After 30 days the data is deleted and reactivation means starting fresh.
This window is not extendable — it exists because we told customers their data
would be deleted, and quietly keeping it would be worse than the inconvenience.
