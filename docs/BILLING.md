# Plans and billing

Turn billing on for the public service with `ARZIO_BILLING=true`. Leave it off
for a private company server: then nobody has plan limits and the screens are
hidden.

## Plans

| Plan | For | Price (before tax) | Mailbox | Emails a day | AI a day | Extras |
| --- | --- | --- | --- | --- | --- | --- |
| Free | personal | free | 5 GB | 300 | 20 | |
| Premium | personal | ₹149 a month or ₹1,490 a year | 100 GB | 1,000 | 500 | priority support |
| Business Basic | organizations, per user | ₹125 a month or ₹1,250 a year | 50 GB | 2,000 | 200 | own domain, shared mailboxes, groups |
| Business Standard | organizations, per user | ₹350 a month or ₹3,500 a year | 100 GB | 5,000 | no limit | plus DLP, retention, litigation hold, eDiscovery |

These are starting values. Change prices and limits in **Service admin >
Plans and revenue**. Existing subscribers keep the price they signed up at
until they change plan.

- Personal accounts start on Free.
- Organizations start on `BILLING_DEFAULT_ORG_PLAN` (Business Basic) with
  `BILLING_TRIAL_SEATS` users (5) until they pay. After that they get as many
  users as seats bought. Shared mailboxes are free.
- Customers pay the price plus `BILLING_TAX_PERCENT` (18% GST). Invoices show
  the tax separately and can be printed or saved as PDF.
- A failed payment keeps the plan for `BILLING_GRACE_DAYS` (7). After that
  the account goes back to Free (or the default business plan).
- Cancelling keeps the plan until the end of the paid period.
- Going over a limit: mail to a full mailbox is refused, sending stops for the
  day, AI says "try again tomorrow". Nothing is ever deleted.

## Razorpay (India: UPI, cards, netbanking)

1. In the Razorpay dashboard, turn on **Subscriptions**.
2. Create API keys and set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
3. Add a webhook to `https://<your host>/webhooks/razorpay` with a secret
   (`RAZORPAY_WEBHOOK_SECRET`) and these events: `subscription.activated`,
   `subscription.charged`, `subscription.pending`, `subscription.halted`,
   `subscription.cancelled`, `subscription.completed`.

Arzio creates the Razorpay plans itself the first time someone buys each one.

## Stripe (cards worldwide)

1. Set `STRIPE_SECRET_KEY`.
2. Add a webhook endpoint `https://<your host>/webhooks/stripe` with these
   events: `checkout.session.completed`, `invoice.paid`,
   `invoice.payment_failed`, `customer.subscription.deleted`. Put its signing
   secret in `STRIPE_WEBHOOK_SECRET`.

With both set up, INR uses Razorpay unless `BILLING_PROVIDER=stripe`.

## Paid by bank transfer

In **Service admin > Plans and revenue > Give a plan by hand**, enter the
person's address (or the organization number shown next to its name), the
plan, seats and months, and tick **Paid** to record an invoice. The plan ends
by itself after those months.

## Test before going live

Use Razorpay or Stripe test keys, buy Premium with a test card, and check
that the plan changes within a few seconds and the invoice appears in
**Settings > Plan & billing**. Then switch to live keys.
