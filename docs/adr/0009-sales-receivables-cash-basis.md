# ADR 0009: Sales documents, receivables and cash-basis reports (Phase 2)

- Status: Accepted
- Date: 2026-09-29

## Context

Phase 2 adds invoices, sales receipts, credit memos, refund receipts, customer payments, bank
deposits and estimates. They must post through the ledger (ADR 0007), keep an A/R subledger that
always agrees with the general ledger, and support cash-basis reporting like QuickBooks.

## Decision

### Documents are transactions plus mutable detail

- A sales document is a `transactions` row (new columns: customer, due date, terms, payment method,
  reference, deposit account, bill-to, email, message, `total`) with its **journal lines** posted by
  `PostingService`, the only way anything affects the books.
- Business detail lives in current-state tables that are replaced on every save: `sales_lines`,
  `payment_applications` and `deposit_lines`. Their history is the audit log (before/after on every
  save). Only `journal_lines` are append-only and versioned. This keeps editing simple without
  losing the accounting trail.
- Postings:

  | Document       | Debit                     | Credit                                |
  | -------------- | ------------------------- | ------------------------------------- |
  | Invoice        | A/R (total)               | income per line                       |
  | Sales receipt  | Undeposited Funds or bank | income per line                       |
  | Credit memo    | income per line           | A/R (total)                           |
  | Refund receipt | income per line           | bank / credit card                    |
  | Payment        | Undeposited Funds or bank | A/R                                   |
  | Deposit        | bank (total)              | Undeposited Funds per payment, others |

  Negative lines (discounts) flip sides. Lines on A/R, A/P, bank or credit card accounts are
  refused. All lines carry the customer.

- Document numbers are unique per type and company among non-deleted documents (a database
  index). Numbers are suggested (`next-number`) but editable, as in QuickBooks.
- Estimates are not transactions (no postings). Converting creates an invoice in the same database
  transaction and closes the estimate.

### Applications and the A/R subledger

- A payment of amount `A` pays invoices `I` and may use credit memos `C`, with
  `C ≤ I ≤ A + C`. The rest, `A + C − I`, is an unapplied customer credit. A credit-only payment
  (`A = 0`) moves no money, so it has no journal lines. The balance trigger allows exactly this case
  (`txn_type = 'payment'` and `total = 0`).
- An application counts from its **effective date**, the later of the payment and invoice dates.
  With that rule, the sum of open items (open invoices − unused credits − unapplied payments + other
  A/R postings) equals the A/R account balance on every date. A property test checks it.
- Consistency rules:
  - targets are locked `FOR UPDATE`;
  - an invoice total can't go below what has been applied;
  - the customer can't change once there are applications;
  - a document with applications can't be voided or deleted until the payment is changed;
  - a deposited payment or receipt keeps its amount and account until it is removed from the
    deposit.
- Aging buckets invoices by due date and everything else by transaction date (QuickBooks
  behavior).

### Cash basis is computed at report time

Profit and Loss, Balance Sheet and Trial Balance accept `basis=accrual|cash`. The default is the
company's accounting method. The General Ledger stays accrual. Nothing is stored:

1. invoice and credit-memo journal lines are left out;
2. every other posting counts as-is (payments still credit A/R);
3. each application, on its effective date, recognises that share of the document. It debits A/R
   by the amount applied and credits each non-A/R line in proportion (signs reversed for credit
   memos).

Shares are allocated on the **cumulative** amount applied, rounded to the cent, with the remainder
going to the largest line. A fully applied document therefore recognises every line exactly. An
overpayment shows as a credit balance in A/R on the cash Balance Sheet, as it does in QuickBooks.
Property tests check that the cash Balance Sheet balances and that accrual minus cash income equals
the amount still receivable.

### Delivery

- Printing uses the browser. Each document has a print layout, and "Save as PDF" produces the PDF.
- Email sends a plain-text summary through the mailer. No PDF is attached yet (Phase 7).

## Consequences

- Reports need no migration when the allocation rule changes; cash-basis numbers are always
  recomputed.
- Unapplied payments can't yet be applied to a later invoice from another payment. They stay a
  credit until the payment is edited. QuickBooks allows this. See open questions.
- Phase 3 (bills, bill payments) reuses the same pattern for A/P and extends cash basis to expenses.
