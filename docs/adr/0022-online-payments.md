# ADR 0022: Online invoice payments through Stripe Connect (Phase 10e)

- Status: Accepted
- Date: 2026-10-07

## Context

Customers should be able to pay invoices online by card or bank transfer (ACH), as with
QuickBooks Payments, and the books should record it without anyone typing it in. The plan uses
Stripe so the platform stays out of PCI scope (master plan, Part A §5).

The owner decided (2026-10-07):

- **Stripe Connect, Standard accounts.** Each business owns a full Stripe account and charges
  are made on it directly. The business handles its own disputes, refunds and negative
  balances in Stripe, and the platform never holds the money.
- **The business pays the processing fees.** There are no surcharges; fees are recorded as an
  expense.
- **QuickBooks-style recording.**
  - Each successful payment is a Receive Payment into Undeposited Funds.
  - Each Stripe payout is one bank deposit grouping its payments, with fee, refund and dispute
    lines, so it matches the bank line exactly.
- **No platform fee** (Stripe application fee) for now.
- **Refunds** go to Refunds and Allowances, an income account that reduces sales; the invoice
  stays paid.
- **Lost chargebacks** go to a Chargebacks expense, and won ones come back to it. Dispute fees
  go to Merchant Fees.
- **Sales tax** on refunded sales stays owed unless it is adjusted by hand, as with write-offs
  (ADR 0021).
- **Until the platform's Stripe account and keys exist, a stand-in is used** (question 66).

## Decision

### The processor seam

- **The interface.** `PaymentProcessor` (`online-payments/processors/`) is the only thing that
  talks to a processor. It can:
  - create an account and its onboarding link;
  - read the account's status;
  - open a checkout;
  - read a payment;
  - list a payout's items;
  - verify and read webhooks.

  Amounts are dollar strings; the processor converts them to its own units.

- **`StripePaymentProcessor`** calls Stripe's REST API directly, with no SDK, like Plaid
  (ADR 0011):
  - `POST /v1/accounts` with `type=standard`, then `POST /v1/account_links` for onboarding.
  - `POST /v1/checkout/sessions` with `Stripe-Account` set to the business's account (a direct
    charge) and no `application_fee_amount`. It is in USD, offers `card` and/or
    `us_bank_account`, and uses our payment id as the idempotency key and client reference.
  - `GET /v1/payment_intents/:id?expand[]=latest_charge` reads the charge, its method and its
    date.
  - `GET /v1/balance_transactions?payout=…&expand[]=data.source` (paged) lists what a payout
    carried, grouped into:
    - charges;
    - refunds;
    - disputes and their reversals;
    - anything else.
  - **Webhooks:** the `Stripe-Signature` HMAC-SHA256 over `timestamp.body` is checked with a
    five-minute tolerance. Only Connect events (those naming an account) are read; the rest are
    acknowledged and ignored.
  - The API version is pinned by `STRIPE_API_VERSION` when set.
- **`MockPaymentProcessor`** (the stand-in, `PAYMENTS_PROVIDER=mock`, the default outside
  production; production refuses it):
  - It keeps its state in memory.
  - Its pages under `/pay/stand-in` play Stripe's onboarding and Checkout.
  - Its "webhooks" are the actions those pages post to `/webhooks/payments/mock`: finish
    onboarding, pay by card or bank, bank clears or fails, refund, dispute, pay out.
  - It charges test fees like Stripe's US list prices: 2.9% + $0.30 for cards, 0.8% capped at
    $5 for ACH, and $15 per dispute.
  - Accounts it no longer remembers after a restart count as set up.
- **Tests** use the stand-in, or the Stripe processor with a fake `fetch` and signed fixtures.
  They never use the network.

### Data (migration 0024)

- `payment_accounts`: one per company. It holds:
  - the provider and its account id (one company per processor account);
  - the status (`pending`, `active`, `restricted`, `disconnected`), charges and payouts
    enabled, and what the processor still needs;
  - the accepted methods;
  - the four accounts activity is recorded to: payout bank, fees, refunds and chargebacks.
- `pay_links`: a link is the customer's credential for one invoice. Only the SHA-256 of its
  32 random bytes is stored. Links are revoked on disconnect.
- `online_payments`: one per checkout. It holds:
  - the session and PaymentIntent ids, the method and amount;
  - the status (`started`, `processing`, `succeeded`, `failed`, `canceled`);
  - the amount refunded and the dispute status;
  - the Receive Payment it became. `succeeded` requires one.
- `processor_payouts`: one per payout. It holds the items, its status (`recorded`, `review`,
  `failed`), a message and the deposit.
- `payment_events`: each webhook event handled, keyed by provider and event id.
- **Lookups without a tenant:** webhooks and pay links arrive without one.
  `app_payment_account_company` and `app_pay_link` (security definer) return only the company
  (and invoice), and the API then works inside `withTenant()`.
- **Deposits may now have negative lines** (fees, refunds, chargebacks) as long as the total
  is positive. Lines taken from Undeposited Funds stay positive. This is a general deposit
  feature: the deposit form accepts them too.

### Events become books

`PaymentEventsService.handle` inserts the event into `payment_events` first, in the same
transaction as its effect. A duplicate does nothing, and a failure rolls back so the processor
retries.

- **Checkout completed or succeeded.** The payment is read from the processor.
  - **Succeeded:** it becomes a Receive Payment through `PaymentsService.saveInTx`, into
    Undeposited Funds. It is applied to the invoice up to its balance, and any excess stays as
    the customer's credit. It is dated when the charge was made (never before the invoice), with
    the method "Credit card" or "ACH / bank transfer", the charge id as reference, and a memo
    "Paid online".
  - **Bank payments** are `processing` until Stripe says they cleared or failed. A failed one
    leaves the invoice open.
- **The books refuse a payment** (say, a closed period). The payment stays `processing` with
  "Received, but not recorded: …" and the reason, and **Record now** retries it later. The money
  is never lost from view.
- **Refund and dispute events** only update the payment's status for display. Their money
  arrives with the payout.
- **Payout paid.** Its items become one deposit to the payout bank account through
  `DepositsService.saveInTx`, dated the arrival date. The deposit has:
  - each charge's Receive Payment from Undeposited Funds; the gross must equal the payment;
  - refunds (to the refund account) and chargebacks and reversals (to the chargeback account),
    named to the invoice's customer;
  - one negative line for all the fees.

  The deposit must equal the payout to the cent, so it matches the bank feed line.

- **Payouts left for review.** Some payouts aren't recorded:
  - one carrying a charge that wasn't made from an invoice here (say, in the Stripe dashboard);
  - one carrying any other activity;
  - one that doesn't add up, or that the books refuse (a negative total, a closed period).

  These are kept with the reason as `review`. Someone can **Try again**, or record the deposit
  by hand and **Mark recorded**. Nothing is guessed.

- **Payout failed** (the bank returned it). The payout is marked `failed` with a note to void
  its deposit.
- **Who the change is recorded as:** the Receive Payments and deposits are recorded as the
  person who connected Stripe (or an owner), as bank feeds do. The online payment's own audit
  rows have no actor.

### Customers and screens

- **Pay links** are made when an invoice with a balance is emailed (the email gets "Pay online
  by card or bank transfer: …"), or with **Get payment link** on the invoice. This works only
  while the account is active and the invoice is in US dollars.
- **The pay page** (`/pay/<token>`) needs no sign-in; the link is the credential. It shows the
  invoice and its balance, and one button per accepted method.
  - A button opens Checkout for the **whole balance**.
  - A bank payment on its way blocks another.
  - Paid, void or unavailable invoices say so.
  - The page polls briefly after returning from Checkout until the payment is recorded.
  - The API is throttled like every route.
- **Company settings › Online payments:**
  - connect (choose the payout bank account, then Stripe's onboarding);
  - status and what Stripe still needs, with **Continue setup**;
  - accepted methods and the four accounts;
  - disconnect (the Stripe account itself stays the business's).

  Returning from onboarding asks Stripe for the account's status. Connecting creates Merchant
  Fees, Refunds and Allowances and Chargebacks if they don't exist.

- **Sales › Online payments:**
  - payments with status, refunds and disputes;
  - payouts with their items and deposit;
  - review actions;
  - under the stand-in, buttons that play Stripe's side: pay out, bank clears or fails, refund,
    dispute.
- **Permissions:**
  - connecting and settings need `company.settings.manage`;
  - seeing payments needs `sales.view`;
  - links, recording again and payout review need `sales.manage`.

## Consequences

- The business's books show online payments exactly like QuickBooks Payments: in Undeposited
  Funds until the payout, then one deposit matching the bank line. Bank feed matching and
  reconciliation work unchanged.
- Fees, refunds and chargebacks are visible as their own accounts, and sales tax on refunds is
  a deliberate manual adjustment.
- Nothing is recorded from a payout that can't be matched; it waits for a person.
- Going live is configuration only: `PAYMENTS_PROVIDER=stripe` with the keys and the webhook
  (question 66).

## Not in this part

- Paying foreign-currency invoices online (question 67).
- Partial payments (question 68).
- Refunds started from the app (question 69).
- Saved payment methods and automatic recurring charges.
- Card surcharges and a platform fee (decided against for now).
