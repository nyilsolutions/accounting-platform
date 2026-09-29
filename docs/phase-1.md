# Phase 1: Ledger core

## Delivered

- **Chart of accounts:**
  - All 15 QuickBooks account types, each with detail types.
  - Sub-accounts up to 5 levels (same type as the parent, no cycles).
  - Optional account numbers.
  - Active/inactive: a balance-sheet account with a balance can't be deactivated.
  - Protected system accounts: A/R, A/P, Undeposited Funds, Opening Balance Equity, Retained
    Earnings, Sales Tax Payable and others.
  - Balances roll up into parents.
- **Default setup for new companies:**
  - A small-business chart of accounts whose equity accounts match the tax form (Schedule C, 1065,
    1120, 1120-S, 990).
  - Standard terms (Due on receipt, Net 15/30/60, 1% 10 Net 30).
  - Payment methods.
  - Companies created before Phase 1 get a one-click "Create standard chart of accounts".
- **Posting engine** (ADR 0007):
  - Append-only, versioned journal.
  - Balance enforced by the database at commit.
  - Closing-date lock enforced by the database.
  - Composite same-company foreign keys.
  - Optimistic concurrency on edits.
- **Journal entries:**
  - QuickBooks-style grid: Account, Debits, Credits, Description, Name, and Class/Location once
    those lists exist.
  - A new line is pre-filled with the amount that balances the entry.
  - Suggested next number.
  - Adjusting-entry flag.
  - Save and new; `Ctrl/⌘+S` saves.
  - Edit, void, delete (records are kept), and reverse into a new entry dated when you choose.
  - Customer required on A/R lines and vendor on A/P lines.
  - Change history link to the audit log.
- **Closing date:**
  - Always password-protected.
  - Posting, editing or voiding in the closed period prompts for the password.
  - Changing the closing date needs the current password.
  - Password changes are audited, but the password itself never is.
- **Lists:**
  - Customers with sub-customers/jobs.
  - Vendors with 1099 flag and **encrypted TIN** (shown masked).
  - Products and services (service, non-inventory, other charge).
  - Classes and locations (nested).
  - Terms and payment methods.
  - Names are unique case-insensitively; inactive entries are hidden from pickers.
- **Reports** (ADR 0008):
  - Profit and Loss (class/location filters), Balance Sheet, Trial Balance, General Ledger.
  - Date presets that respect the fiscal year.
  - Drill-down: report → general ledger → transaction.
  - CSV export and print layout.
  - The dashboard shows a fiscal-year-to-date P&L summary.
- **Permissions:**
  - Accounts can be listed by every role, but balances only by roles that see the books.
  - Journal entries need `ledger.*`; customers need `sales.*` or `ledger.*`; vendors need
    `purchases.*` or `ledger.*`; reports need `reports.view`.
  - The **Standard** role now includes `reports.view`, matching QuickBooks "Standard all access".
- **Shortcuts:** `g a` Accounting, `g j` New journal entry, `g r` Reports, `g t` Lists.
- **Seed:** the demo company has a chart of accounts, classes, a customer, a vendor, an item and
  three months of entries.

## Demo script

1. Run `pnpm db:migrate && pnpm db:seed && pnpm dev`, then sign in as `demo@example.com`.
2. Press `g a` to open the chart of accounts, and add a sub-account under _Car and Truck_.
3. Press `g j` for a new journal entry. Choose _Checking_, debit 500, then choose _Services_ on the
   next line: the 500 credit fills in. Press `Ctrl+S` to save.
4. Press `g r` and open **Profit and Loss** (class filter: Residential). Click an amount to drill
   into the General Ledger, then click a date to open the entry.
5. Open **Balance Sheet**. Total assets equal total liabilities and equity. Net Income matches the
   P&L.
6. Press `g c`. Close the books through last month with a password, then edit an entry from that
   month: you'll be asked for the closing password.
7. Press `g l`. Every change is in the audit log, with before and after values.

## Tests

| Suite                   | Count | Highlights                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`       | 23    | Money: exact decimal math, rounding, a fast-check round-trip. Fiscal presets. Journal-entry validation.                                                                                                                                                                                                                                 |
| `packages/crypto`       | 13    | Unchanged                                                                                                                                                                                                                                                                                                                               |
| `packages/db`           | 23    | +14 ledger tests at the database level: unbalanced entries, single lines, both-sided lines and version bumps are all rejected; journal lines and transactions can't be updated or deleted by the app role; closing-date lock and override; cross-company foreign keys; sub-account type and cycle rules                                 |
| `apps/api`              | 50    | +28: default chart per tax form; account rules; journal entry create, edit, stale-version, reverse, void, delete; A/R and A/P name rules; closing-date flows; lists with encrypted TIN; role permissions; cross-company references; known-answer P&L, BS, TB and GL; year-end close; class filter; **property-based ledger invariants** |
| `apps/web` (Playwright) | 3     | +1: chart of accounts → journal entries with auto-balancing → P&L → GL drill-down → entry; Balance Sheet; closing-date password prompt; customers, vendors, classes; audit trail                                                                                                                                                        |

## Known gaps and decisions for later phases

- Reports are accrual basis only. Cash basis comes with invoices and bills.
- The General Ledger is capped at 20,000 rows. Paging and Excel/PDF exports are in Phase 7.
- Names are unique within customers and within vendors, not across both (QuickBooks Online makes
  them unique across both; see open questions).
- Payment methods are not used by any transaction yet (Phase 2).
- Vendor TIN reveal and TIN matching come with 1099 reporting (Phase 3/9).
- No "restore a previous version" UI yet. History is kept in the database and the audit log.
- Budgets, multi-currency and inventory items are in later phases.
