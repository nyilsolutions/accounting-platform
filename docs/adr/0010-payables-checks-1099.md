# ADR 0010: Payables, checks and 1099 tracking (Phase 3)

- Status: Accepted
- Date: 2026-09-29

## Context

Phase 3 adds bills, vendor credits, bill payments, checks, expenses, credit card credits,
purchase orders, check printing and 1099 tracking. It should reuse the Phase 2 design (ADR 0009)
instead of building a second one.

## Decision

### One subledger engine for A/R and A/P

- `ledger/subledger.ts` computes open items for either side:

  | Side | Documents | Credits       | Payments     | Control account | Party    |
  | ---- | --------- | ------------- | ------------ | --------------- | -------- |
  | A/R  | invoice   | credit memo   | payment      | A/R             | customer |
  | A/P  | bill      | vendor credit | bill payment | A/P             | vendor   |

- The same effective-date rule applies to both, so each subledger ties to its control account on
  every date. Property tests check this for both sides.
- Aging, open documents and balance summaries are one set of pure layouts
  (`reports/ar-report-builder.ts`), with a `party` switch that decides whether rows drill down to
  customers or vendors.
- Bill payments apply to bills and vendor credits through the same `payment_applications` table
  that customer payments use.

### Postings

| Document           | Debit                 | Credit              |
| ------------------ | --------------------- | ------------------- |
| Bill               | expense/item lines    | A/P (vendor)        |
| Vendor credit      | A/P                   | expense/item lines  |
| Check, expense     | expense/item lines    | bank or credit card |
| Credit card credit | credit card           | expense/item lines  |
| Bill payment       | A/P (bills − credits) | bank or credit card |

- Lines may carry the customer or job the cost was for. A journal line names one party, so such a
  line carries the customer; the vendor stays on the header and on the A/P or payment line.
- A/R and A/P are control accounts and can't be used on expense lines. A line can't use the
  account that pays.
- **A bill payment pays exactly bills − credits.** There is no unapplied remainder, unlike
  customer payments. A prepayment is entered as a check or expense instead. When the credits
  equal the bills, the payment moves no money and has no journal lines; migration 0005 extends
  the balance trigger to allow this for `bill_payment` too.
- Pay Bills records one bill payment per vendor, all in one database transaction.

### Checks

- Checks and bill payments paid from a bank are checks. They are either numbered when saved (the
  next number is one more than the highest used on that account) or queued with "print later"
  (`print_status = 'to_print'`, no number).
- Printing assigns consecutive numbers, refuses numbers already used on the account, and marks the
  checks printed through `PostingService.markCheckPrinted`. That is a metadata change: no new
  journal version, and it is allowed in a closed period. The API returns what goes on each
  check: amount in words and voucher stub lines.
- Check layout is a voucher check (check plus two stubs) printed from the browser.

### Cash basis extends to payables

On the cash basis, bill and vendor-credit postings are replaced by recognition on each bill
payment application. This is the same allocation as ADR 0009, with the control account generalized
to A/R or A/P. The recognition stream (`recognitions()` in `reports/cash-basis.ts`) is shared by
cash-basis reports and 1099 tracking.

### 1099 tracking follows the money

- Only vendors marked "track for 1099" count, and only amounts on expense accounts mapped to a 1099
  box (`vendor_1099_accounts`, like the QuickBooks 1099 wizard).
- Amounts count when paid:
  - checks and expenses paid from a bank count on their date;
  - bills count as bill payments apply them, in proportion to the bill's lines;
  - vendor credits used reduce the amount.
- Card payments are excluded. Payment-card transactions are reported by the card processor on
  Form 1099-K.
- Reporting thresholds come from `/tax-data/<year>/form-1099.json` with citations (CLAUDE.md
  rule 7). For 2026 the NEC/MISC threshold is $2,000 under the One Big Beautiful Bill Act (royalties
  stay $10); for 2025 it is $600. The files are marked unreviewed until a CPA signs off (see open
  questions).

### Purchase orders

Purchase orders don't post, like estimates. "Copy to bill" creates the bill in the same database
transaction and closes the PO. Partial receipts and item receipts come with inventory (Phase 10).

## Consequences

- Phase 4 (banking) reads checks, expenses and deposits as register entries without new document
  types. Reconciliation and bank feeds match against them.
- 1099 forms (Phase 9) read from `vendor1099Summary`, so the numbers users review now are the
  numbers that will be filed.
- Early-payment discounts on bill payments aren't modelled yet (see open questions).
