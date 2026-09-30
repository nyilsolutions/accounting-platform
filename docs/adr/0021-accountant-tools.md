# ADR 0021: Accountant tools (Phase 10d)

- Status: Accepted
- Date: 2026-09-30

## Context

Phase 10d gives a company's accountant the tools QuickBooks Online Accountant puts in its
"Accountant tools" menu: fix the client's usual mistakes, see what the client changed, and close
the month.

The owner decided (2026-09-30):

- **Client changes:** a review list built from the audit log. It shows what people who aren't the
  company's accountants added, changed, voided or deleted in transactions and the chart of
  accounts, with before and after. Changes in a closed period are flagged. The accountant marks
  them reviewed one by one or all shown at once.
- **Close the books:** a month-end checklist whose statuses are worked out live:
  - every bank and credit card account reconciled through the month end;
  - Undeposited Funds empty;
  - nothing uncategorized in the month;
  - client changes reviewed;
  - a revaluation, if foreign-currency balances are open;
  - the A/R and A/P aging looked over (by hand).

  Any step can be marked done by hand with a note. Closing sets the closing date (and password)
  and records the close.

- **Write off invoices:** a credit memo to **Bad Debts** (created if missing), applied to the
  invoice by a payment of zero. The **sales tax stays owed** to the agency.
- **Reclassify:** move lines to another **account and class**, many at once, after filtering.
  - It covers journal entries and the income and expense lines of invoices, receipts, bills,
    checks and expenses; the documents' own lines change too.
  - A/R, A/P, bank, card, payroll, sales tax and inventory lines never move.
  - Changes in a closed period need the closing password.

## Decision

All the tools live in `apps/api/src/accountant/` and are served under
`companies/:companyId/accountant`. Reading needs `ledger.view` (the client changes list needs
`audit.view`); changing anything needs `ledger.manage`. Every change is audited in the same
transaction.

### Reclassify

- `GET reclassify` lists posted lines by account, class, customer or vendor, date range and
  transaction type (up to 1,000). Lines on fixed accounts aren't listed:
  - account types A/R, A/P, bank and credit card;
  - system roles Undeposited Funds, Sales Tax Payable, payroll, inventory asset, exchange gain
    or loss, opening balance equity and retained earnings.

  The same list is refused as a target account. Foreign-currency control accounts are A/R or
  A/P, so they are fixed too.

- `POST reclassify` takes the chosen lines, a new account and/or class (a null class clears
  it) and the closing password.
- **Posting:** `PostingService.reclassifyLines` writes a new version of each transaction with
  the same amounts, parties and dates, and only the account and class changed. It validates the
  lines as any posting does and guards the closing date. It is the only way a line's account
  changes without re-saving the document through its own service.
- **Document lines:** sales and purchase documents keep their business detail in `sales_lines`
  and `purchase_lines` (ADR 0009, 0010), so the matching document line changes too. Otherwise
  the next edit would put the old account back.
  - The mapping is deterministic. A document posts its total first (journal line 1), then one
    journal line per document line with a non-zero amount (in US dollars, as converted), in
    order, then sales tax and inventory lines (`documentLines`).
  - The service checks that the mapped document line has the journal line's account before
    changing it.
  - `acct_app` can't update those tables, so the document's lines are read, deleted and
    inserted again with the change, as a save does.
- **Product and service lines** post to the item's account. Only their class changes
  (`canChangeAccount: false`); moving their account means changing the item.

### Write off invoices

- `GET write-off` lists open invoices at least N days past due as of a date (from the A/R
  subledger, `openItems`), in the invoice's currency with the US dollar value.
- For each chosen invoice, `POST write-off` does two things in one transaction:
  - It saves a **credit memo** for the whole open balance through `SalesDocumentsService.saveInTx`.
    The memo has one line to the write-off account, in the invoice's currency at the invoice's
    rate. It carries no sales tax, so what the agency is owed doesn't change.
  - It saves a **payment of zero** through `PaymentsService.saveInTx`, applying the invoice and
    the credit memo against each other.
- The account defaults to **Bad Debts** (an expense account, detail type Bad Debts). It is
  created on first use.
- A state's bad-debt deduction for sales tax is entered as a sales tax adjustment (ADR 0014),
  not by the write-off.

### Fix undeposited funds

- `GET undeposited-funds` lists two things:
  - payments waiting in Undeposited Funds;
  - deposit lines recorded straight to an income account for a customer. For each such line it
    suggests the waiting payments from that customer that add up to it.
- `POST undeposited-funds/fix` replaces one such deposit line with the chosen payments. Their
  total must equal the line. The deposit is saved again through `DepositsService.saveInTx`, so
  the bank amount doesn't change. Income is no longer counted twice, and the payments leave
  Undeposited Funds.

### Client changes

- **Source:** the audit log, with no copy. A change is a row whose entity is a transaction or an
  account, made by someone whose membership role isn't `accountant`.
- **Details:**
  - before and after come from the audit row;
  - the transaction's type, number and date come from the transaction;
  - a change is **in a closed period** when the transaction's date is on or before the closing
    date.
- **Reviews:** `audit_reviews` (company, audit row, who, when) records reviews, since the audit
  log itself is never updated. Unmarking deletes the review.
- `unreviewedCount(tx, companyId, through)` counts unreviewed changes to transactions dated on
  or before a date, plus unreviewed account changes. The close checklist uses it.

### Close the books

- `GET close/:periodEnd` (the last day of a month) works out each step live (see the owner's
  decisions for the list). Each step is `done`, `not_needed` or `attention`, with a sentence
  saying why. The revaluation step checks for a posted revaluation dated the month end.
- **Marks by hand:** `close_step_marks` holds them (one per company, month and step, with a note
  of up to 1,000 characters). A mark turns the step `done` and shows who marked it and the note.
  - Marking is how an accountant accepts a step the numbers can't prove, such as a bank
    reconciled outside the product.
  - The A/R and A/P aging step is only ever done by hand.
- **Closing:** `POST close/:periodEnd` is refused with `409 CLOSE_NOT_READY` while any step
  needs attention, and with 409 when the books are already closed through that date. Otherwise
  it does three things in one transaction:
  - It sets the closing date to the month end through `LedgerSettingsService.updateInTx`, with
    the same password rules as Company settings: a new password, or the current one to change
    it.
  - It records the close in `period_closes`, with a snapshot of the checklist and an optional
    note. The table is insert-only for `acct_app`.
  - It audits `period.closed`.

### Adjusted Trial Balance

- The report shows, for each account:
  - the unadjusted balance (transactions not marked adjusting);
  - the adjusting journal entries;
  - the adjusted balance.

  Each column is a debit and credit pair.

- It uses `ledgerNet` with the new `adjusting` filter.
- On the cash basis, cash recognitions of invoices and bills are never adjusting, so they are
  left out of the adjustments column.

### Screens

- **Accounting › Accountant tools** has one card per tool:
  - Reclassify, Write off invoices, Fix undeposited funds, Review client changes and Close the
    books;
  - a link to the Adjusted Trial Balance.
- The pages are under `accounting/tools/`. Reclassify asks for the closing password through the
  shared dialog when a line is in a closed period.

## Consequences

- Accountants fix the common mistakes without re-entering documents. Every fix goes through the
  posting engine and the documents' own services, so subledgers, sales tax and inventory stay
  tied.
- Reclassifying relies on the order in which documents post their lines. A change to that order
  must update `documentLines`; the reclassify tests cover each document type.
- Reviews live beside the audit log rather than in it. A deleted membership leaves its old
  changes listed under the person's name, with no role, as client changes.
- The close checklist is worked out live, so it can change after closing; `period_closes`
  keeps what it showed at the close.

## Not in this part

- **Several clients at once:** a list of every client's checklist and changes. It isn't in the
  plan yet.
- **Reclassifying lines on a payroll, inventory or bank transaction.** These post through their
  own workflows; fix them there.
