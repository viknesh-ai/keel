# Frequently asked questions

_Last reviewed: 12 August 2026. Owner: Support._

## Account and access

**How do I add someone to my account?**
Settings → Team → Invite. They get an email with a link valid for 7 days. Seats
are counted against your plan limit at the moment the invite is accepted, not
when it is sent, so inviting six people on a five-seat plan will let five in.

**Someone left and I want their access gone now.**
Settings → Team → Remove. Access ends immediately and any active session is
invalidated. Their audit history stays — removing a person does not rewrite what
they did.

**I have not logged in for a while. Is my account still there?**
Yes. We do not delete accounts for inactivity. If the subscription lapsed, see
the subscription policy for the reactivation window.

## Billing

**Why is my invoice higher than my plan price?**
Almost always overages or tax. The invoice itemises both. Overages from last
month appear on this month's invoice, which is the usual source of confusion.

**Can I change my billing currency?**
No. Currency is fixed at signup from the billing address. Changing it means
starting a new subscription. See pricing.

**Can I get a copy of an old invoice?**
Billing → Invoices, all history, downloadable as PDF. Nothing expires.

**My card was declined.**
The subscription moves to `past_due` and the account keeps working. Update the
card in Billing → Payment method and we retry within an hour. Suspension only
happens at 45 days.

## Cancelling

**How do I cancel?**
Settings → Subscription → Cancel. The default keeps access until the end of the
period you have already paid for. You can undo it any time before then.

**Will I get a refund for the rest of my annual term?**
Not automatically — annual plans are not refunded pro rata mid-term. Credit
toward a future term or a downgrade with credit are usually available. See the
refund policy.

**What happens to my data?**
It is kept for 30 days after cancellation so you can reactivate. After 30 days it
is deleted and cannot be recovered. Export first: Settings → Data → Export.

## Data and security

**Where is my data stored?**
Indian customers: Mumbai. Everyone else: Frankfurt. Region is set at signup and
does not move.

**Do you have an audit log?**
Yes, on Pro and Enterprise, covering every change to customers, subscriptions and
team membership, with the acting user and timestamp. 400 days of history.

**Is there an API?**
Yes. The OpenAPI specification is at `/openapi.yaml`. Authentication is a bearer
token from Settings → API keys, or a session cookie for browser callers.

## Support

**How fast will you respond?**
Free and Starter: two business days. Pro: one business day. Enterprise: four
hours during business hours, with an on-call path for outages.

**Something is broken and it is urgent.**
Say so in the first line of the ticket. We triage on impact, not on plan, and a
production outage on a Starter plan is handled before a question on Enterprise.
