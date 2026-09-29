# ADR 0008: Financial reports (Phase 1)

- Status: Accepted
- Date: 2026-09-29

## Decision

- **Reports are computed from the ledger on demand.** There are no stored balances, so nothing can
  drift. Each report runs in one `REPEATABLE READ` transaction, so all of its queries see the same
  snapshot.
- **Automatic year-end close, as QuickBooks does it.** There are no closing entries:
  - The Balance Sheet adds all prior fiscal years' net income to the Retained Earnings account and
    shows the current fiscal year's income as a calculated **Net Income** line.
  - The Trial Balance shows P&L accounts fiscal-year-to-date, and includes prior years' income in
    Retained Earnings, so its columns always agree.
- **Layout is done by pure functions** (`apps/api/src/reports/report-builder.ts`):
  - Sections, sub-accounts (parent header → children → parent's own postings → "Total parent"),
    calculated lines, and rows omitted when zero.
  - The API returns structured rows, so the web view, CSV export and future PDF/Excel all share
    one layout.
- **Drill-down:**
  - Every account amount links to the General Ledger for that account over the period the amount
    covers (`drillFrom` to the report date).
  - A parent account's General Ledger includes its sub-accounts.
  - Every General Ledger row links to its transaction.
- **General Ledger:**
  - Shows a beginning balance, and normal-balance running balances.
  - The "Split" column shows the other account, or `-Split-` when there are several.
  - Output is capped at 20,000 rows with a `truncated` flag. Paging arrives with the Phase 7
    reports suite.
- **Accrual basis only for now.** Cash-basis conversion needs invoices and bills (Phases 2–3) to
  decide which income and expenses are "paid". The API labels every report `accrual`.
- **Invariants are tested with random data.** A fast-check property test creates random balanced
  entries in a July fiscal year and checks every time that:
  - the Trial Balance debits equal its credits;
  - the Balance Sheet balances;
  - P&L net income equals the Balance Sheet's Net Income;
  - every balance-sheet account ties to its General Ledger ending balance.
