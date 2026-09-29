# Phase 2: Sales and accounts receivable

## Delivered

- **Sales documents** (ADR 0009): invoices, sales receipts, credit memos and refund receipts.
  - Product/service grid: choosing a product fills its description and price, and quantity ×
    rate gives the amount (exact decimal math, rounded to the cent). A line can use an income
    account instead of a product. Negative lines are discounts. Service date and class per line.
  - Invoice terms and due date (from the customer's terms by default), bill-to address and email
    from the customer, a message printed on the document, and an internal memo.
  - Suggested numbers (1001, 1002, …), unique per document type.
  - Sales receipts go to Undeposited Funds by default. Refund receipts are paid from a bank or
    credit card account.
  - Save and new, Save and send, `Ctrl/⌘+S`. Edit, void and delete (records are kept), all behind
    the closing-date password.
  - **Print or save as PDF** layout for every document, and **email** to the customer (the
    `sent_at` date is shown on the document).
- **Receive payment:**
  - Enter the amount and it is applied to the oldest invoices first, or tick invoices and credit
    memos individually.
  - Overpayments stay as a customer credit. Credit-only payments apply a credit memo to an invoice.
  - Deposit to Undeposited Funds or a bank account.
  - Voiding or deleting a payment reopens the invoices it paid.
- **Bank deposits:** group the payments and receipts waiting in Undeposited Funds, add other funds,
  and deposit them to a bank account. Deposited payments are locked until removed. Voiding a
  deposit returns them to Undeposited Funds.
- **Estimates:** pending, accepted or rejected, with an expiration date. Print and email. **Convert
  to invoice** in one click; a converted estimate is locked and links to its invoice.
- **Customers:**
  - The customer list shows open balances.
  - Each customer has a page with open balance, overdue amount, available credit, transactions
    and quick actions.
  - **Balance-forward statements** with aging, for any date range, printable.
- **Sales hub:** a money bar (open, overdue, unused credits) and every sales transaction, with
  filters for type and status (open, overdue, paid), search, voided entries and paging.
- **Reports:**
  - A/R Aging Summary and Detail, Open Invoices, Customer Balance Summary.
  - Sales by Customer Summary, Sales by Product/Service Summary.
  - **Cash basis** for Profit and Loss, Balance Sheet and Trial Balance: a toggle on the report,
    defaulting to the company's accounting method (ADR 0009).
  - Drill-down from customers and transactions. The General Ledger now links every row to the
    right document.
  - The reports page is grouped like QuickBooks.
- **Dashboard:** an Invoices card with unpaid and overdue totals.
- **Shortcuts:**

  | Keys  | Opens           |
  | ----- | --------------- |
  | `g n` | New invoice     |
  | `g y` | Receive payment |
  | `g k` | Bank deposit    |

  The new-transaction pages are also in the `Ctrl/⌘+K` palette.

- **Permissions:**
  - Sales documents, payments and estimates need `sales.view` or `sales.manage`.
  - Deposits need `banking.manage`, as in QuickBooks.
  - Reports need `reports.view`.
- **Seed:** the demo company has three invoices (paid, partly paid, open), two payments, a
  deposit and an open estimate.

## Demo script

1. Run `pnpm db:migrate && pnpm db:seed && pnpm dev`, then sign in as `demo@example.com`.
2. Press `g n`. Choose _Hillside HOA_ and the _Weekly lawn service_ product (85.00 fills in), set
   quantity 4, and add a discount line of −20 on _Discounts Given_. Choose **Save and send**; the
   email goes to the development mail transport (`MAIL_TRANSPORT`).
3. On the invoice, choose **Print or save PDF** to see the printed layout.
4. Choose **Receive payment**. Change the amount to 200 and tab out: it is applied to the oldest
   invoice. Save.
5. Press `g k`, tick the payments and save the deposit. They now show as _Deposited_.
6. Open **Sales › Estimates**, open the Oakwood Dental estimate and choose **Convert to invoice**.
7. Open **Customers › Hillside HOA › Statement**.
8. Press `g r`, open **A/R Aging Summary** and click a customer. Open **Profit and Loss** and switch
   **Accounting method** to Cash: income appears only as it is paid.

## Tests

| Suite                   | Count | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared`       | 30    | +7: line amounts (quantity × rate, rounding, a property test), document/payment/deposit validation, due dates from terms                                                                                                                                                                                                                                                                                                                                     |
| `packages/crypto`       | 13    | Unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/db`           | 29    | +6: zero-line credit-only payments, one deposit per payment, cross-company applications, estimate RLS, `sent_at` updates in a closed period                                                                                                                                                                                                                                                                                                                  |
| `apps/api`              | 84    | +34: every document type and its postings, numbering, edits and stale versions, email; partial payments, overpayments, credit memos, application rules; deposits and locks; refunds; estimates and conversion; list filters and paging; statements; A/R ties to the GL; known-answer A/R and cash-basis reports; allocation and layout unit tests; **property tests**: aging = A/R balance, cash Balance Sheet balances, accrual − cash income = receivables |
| `apps/web` (Playwright) | 4     | +1: invoice → print → email → partial payment → sales receipt → bank deposit → estimate conversion → customer statement → A/R aging drill-down → cash-basis P&L → dashboard                                                                                                                                                                                                                                                                                  |

## Known gaps and decisions for later phases

- **Unapplied payments** stay a credit on the payment. They can't be picked as a credit in another
  payment yet (see open questions).
- **No server-side PDF.** Printing uses the browser's "Save as PDF", and emails are plain text
  without an attachment (Phase 7, with the reports suite).
- **Email:** development transports only (console, file, capture). A production provider is an
  open question.
- **Sales tax:** the `taxable` flag is stored on lines, but no tax is calculated (Phase 7).
- **Not yet built:** delayed charges and credits, recurring invoices, progress invoicing, online
  payments, late fees, custom invoice templates and logos.
- Sales-by reports are accrual basis. Cash basis applies to P&L, Balance Sheet and Trial Balance.
- Deposits live under Sales for now and move to Banking in Phase 4.
