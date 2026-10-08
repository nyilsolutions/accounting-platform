# ADR 0007: Ledger posting model

- Status: Accepted
- Date: 2026-09-29

## Context

Every later module posts to the general ledger: invoices, bills, checks, deposits, paychecks,
bank-feed matches and QuickBooks imports. The ledger must stay balanced, its history must not be
rewritable, closed periods must stay closed, and one company's postings must never reference
another company's accounts.

## Decision

- **One header, many lines.** `transactions` holds one row per business document (type, date,
  number, memo, status, version). `journal_lines` holds the debits and credits, each tagged with
  account, customer or vendor, class and location.
- **Append-only lines with versions.**
  - Editing a transaction bumps `transactions.version` and inserts a complete new set of lines.
  - Reports read only lines where `line.version = transaction.version` and
    `transaction.status = 'posted'`.
  - The app role has no UPDATE/DELETE grant on `journal_lines`, and a trigger also rejects them.
  - Earlier versions stay in the database, and the audit log records a readable before/after of
    every change.
- **Void and delete never remove data.**
  - **Void** keeps the document visible, with no effect on balances.
  - **Delete** hides it from lists and reports.
  - The app role cannot delete transactions at all.
- **Balanced at commit.** A `DEFERRABLE INITIALLY DEFERRED` constraint trigger checks that the
  current version has at least two lines and that debits equal credits. The API validates the same
  rules first so users see friendly errors.
- **Closing date in the database.** A trigger blocks inserts or updates dated on or before
  `companies.closing_date`, unless the API has verified the closing password and set the
  transaction-local `app.closing_override`. A closing date always requires a password. Changing or
  removing one requires the current password.
- **Composite foreign keys.** Every reference uses `(company_id, id)`, so a line cannot point at
  another company's account, customer, class or location, even with a forged id. RLS applies on
  top of that.
- **`PostingService` is the only way to post.** It handles validation (active accounts, a customer
  on A/R lines, a vendor on A/P lines, active names and dimensions), the closing-date check,
  optimistic concurrency (`version`) and versioned writes. Future document types convert
  themselves to a header plus lines and call it.
- **Money** is `NUMERIC(19,4)` in the database, `bigint` in 1/10,000 units in TypeScript
  (`@acct/shared/money`), and a decimal string in JSON. User-entered transaction amounts allow 2
  decimals; unit prices and costs allow 4.
- **Dates** are `date` columns, parsed as `YYYY-MM-DD` strings (never JS `Date`), so time zones
  can't shift an entry into another day or period.

## Consequences

- Report queries always join the header to filter version and status. Indexes cover
  `(company_id, account_id, txn_date)` and `(transaction_id, version)`.
- Storage grows with every edit. That is acceptable for an accounting system and needed for audit.
- A future "restore previous version" feature is straightforward.
