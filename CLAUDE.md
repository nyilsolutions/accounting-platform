# CLAUDE.md

Cloud accounting and US payroll platform with QuickBooks-style workflows. The full product brief and
phase plan are in `docs/master-plan.md` (Part B is the build spec). Decisions are recorded in
`docs/adr/`, and each phase has a report in `docs/phase-N.md`. Unresolved tax, legal and
product questions go in `docs/open-questions.md`. **Ask the user rather than guessing.**

## Commands

```bash
docker compose up -d            # Postgres 16 (or use a local Postgres)
cp .env.example .env
pnpm install
pnpm build                      # builds packages (required before db scripts / API dev)
pnpm db:setup                   # creates the acct_app role + databases (local/CI only)
pnpm db:migrate                 # applies packages/db/migrations/*.sql as the owner
pnpm db:seed                    # demo user + "Sample Landscaping Co." (prints MFA secret)
pnpm dev                        # API :4000 + web :3000 (web proxies /api -> API)

pnpm lint && pnpm typecheck && pnpm test   # all unit/integration tests (need Postgres)
pnpm e2e                        # Playwright; needs `pnpm build` first, ports 3000/4000 free
pnpm format                     # prettier
```

A single package: `pnpm --filter @acct/api test`, `pnpm --filter @acct/db test`, etc.

## Layout

- `apps/api`: NestJS 11 REST API (Express 5). Modules: auth, companies, members, audit, mail, health,
  ledger (accounts, journal entries, posting engine, ledger settings), lists, sales (invoices,
  receipts, credit memos, refunds, payments, deposits, estimates), purchases (bills, vendor credits,
  bill payments/pay bills, checks and check printing, expenses, credit card credits, purchase
  orders, 1099 in `vendor-1099.ts`), banking (transfers, registers, reconciliation, bank feed
  For Review/rules/import, connections through `BankDataProvider` with Plaid and a mock in
  `banking/providers/`), documents (library, versions, links, receipts inbox and reading,
  email-in; storage, scanning and extraction behind interfaces in `documents/`), migration
  (QuickBooks import: sources in `migration/sources/` map to canonical records, `import-engine.ts`
  creates them through the normal services, `tie-out.ts` is the Migration Report; QuickBooks
  Online behind `QboApi` with a mock), sales-tax (agencies, rates, the `SalesTaxCalculator`,
  payments and adjustments, the liability report), budgets, reports (every report dispatched by
  key in `reports.service.ts` over a `ReportScope`; statements in `financial-reports.ts`, detail
  and banking reports in `detail-reports.ts`, the custom builder in `custom-report.ts`, exports
  in `reports/export/`, memorized reports and the email scheduler in
  `memorized-reports.service.ts`; cash basis in `cash-basis.ts`), payroll (setup in
  `payroll-setup.service.ts`, employees with W-4/state certificate history, direct deposit and
  prenotes in `employees.service.ts`, NACHA records in `nacha.ts` behind `PaymentRail`; the tax
  engine in `payroll/tax/` (pure, exact fractions); paychecks built by `paycheck-calc.ts` and run
  by `pay-runs.service.ts`; liabilities in `liabilities.ts` with payments through `EftpsProvider`;
  payroll reports in `payroll-reports.ts`).
  The A/R and A/P subledgers share one engine: `ledger/subledger.ts`.
- `apps/desktop-agent`: QuickBooks Desktop migration agent (C#/.NET 8; `Core` is portable and
  tested on Linux with `dotnet test`, `Windows` is the WinForms wizard and QBXMLRP2 session).
- `apps/web`: Next.js 16 (App Router) + TanStack Query + Tailwind 4. Calls the API only via `/api/*`.
- `packages/db`: plain-SQL migrations, migrator, Kysely types, `withTenant()`, `createTestDatabase()`.
- `packages/crypto`: server-only: argon2id, TOTP, AES-256-GCM field encryption, tokens.
- `packages/shared`: zod schemas, DTO types, roles and permissions (used by API **and** web).
- `tax-data/<year>/*.json`: tax thresholds and tables with citations, loaded by
  `apps/api/src/common/tax-data.ts`.

## Non-negotiable rules

1. **Money is never a float.** Use `NUMERIC(19,4)` columns (parsed as strings by `pg`) and decimal
   helpers. ESLint forbids `parseFloat`.
2. **Tenant data goes through `withTenant(db, { userId, companyId }, tx => …)`.** It sets the RLS
   context transaction-locally. Every tenant table has `company_id` and RLS policies in its
   migration, plus a test in `packages/db/src/rls.test.ts` style proving isolation.
3. The API connects as **`acct_app`** (no BYPASSRLS, owns nothing). Migrations run as the owner.
   Never grant `acct_app` ownership or `UPDATE/DELETE` on `audit_log`.
4. **Every state change writes an audit row in the same transaction** (`AuditService.record(tx, …)`).
   Sensitive values (SSN, EIN, bank numbers, secrets) are never written to the audit log or to logs.
   Store them encrypted with `FieldEncryptor` using an AAD that binds the value to its row.
5. **Migrations are append-only.** Never edit an applied migration (the migrator rejects checksum
   changes). Add `NNNN_description.sql`.
6. **Everything that affects the books posts through `PostingService`** (ADR 0007). Never write to
   `transactions`/`journal_lines` directly. Lines are append-only and versioned. Reports read only
   `line.version = txn.version AND status = 'posted'`. Void and delete keep the record.
7. Tax rates, wage bases and tables live in `/tax-data/<year>/` with a source citation, never in code.
8. Validation schemas live in `packages/shared` and are used by both the API (`ZodPipe`) and web.
9. Routes require a session with completed MFA by default. Use `@Public()` / `@AllowPendingMfa()` only
   deliberately. Company routes use `CompanyAccessGuard` + `@RequirePermission(...)`. Non-members get 404.
10. State-changing requests need the `x-csrf-protection: 1` header (the web `api()` helper sends it).
11. Tests are required for every feature. Use real Postgres, not mocks, for data-access tests.

## Conventions

- DB columns are snake_case. DTOs and JSON are camelCase. IDs are UUIDs; `audit_log.id` is a bigint
  string.
- API errors: Nest HTTP exceptions; validation errors are `400 { message, errors: [{ path, message }] }`.
- Web: client components with TanStack Query. Query keys are in `apps/web/src/lib/queries.ts`.
- Keyboard shortcuts: `apps/web/src/components/shell/nav.ts` (`g <key>`), `Ctrl/⌘+K` palette, `?` help.
- Money: `@acct/shared` `parseMoney`/`moneyToString`/`formatMoney` (bigint, 1/10,000 units). Dates:
  `YYYY-MM-DD` strings (`@acct/shared` dates helpers), never JS `Date`, for accounting dates.
- Report layout: pure functions in `apps/api/src/reports/report-builder.ts` and
  `ar-report-builder.ts`; the API returns rows and the web renders them generically
  (`components/reports/report-view.tsx`). Tabular reports set `textColumns` and per-row `cells`.
- Sales and purchase documents keep their business detail in mutable tables (`sales_lines`,
  `purchase_lines`, `payment_applications`, `deposit_lines`) replaced on save; only journal lines
  are versioned (ADR 0009, 0010). Keep the A/R and A/P subledgers tied to the GL: open items must
  sum to the control account balance (property tests check this).
- A journal line names one party (`customer_id` or `vendor_id`, never both).
- Banking uses the account's natural sign (bank: debits raise the balance; card/loan: credits
  raise what's owed). Bank amounts are "money in" positive = debit − credit on the account.
  Cleared/reconciled marks live in `bank_clearings`, never on journal lines (ADR 0011).
- Bank statement parsers (`packages/shared/src/bank-files.ts`) are pure and shared: the web
  previews, the API re-parses. External calls (Plaid) go through `BankDataProvider`; tests use the
  mock or a fake `fetch`, never the network.
- Transaction links in the web go through `apps/web/src/lib/links.ts` (`txnHref`).
- Files: detect types from bytes (`detectFileType`), never trust names or browser types. Bytes go
  through `ObjectStore` (never the filesystem directly), are scanned by `VirusScanner` before they
  are usable, and are downloaded only through `DocumentsService.url()` (permission check, 5-minute
  link). Receipt reading goes through `ReceiptExtractor`; tests use fakes, never the network
  (ADR 0012).
- QuickBooks import (ADR 0013): every source maps to the canonical schemas in
  `packages/shared/src/migration.ts`; never write a source-specific path into the engine.
  Imported records go through the services' `*InTx` methods (never direct inserts) and are keyed
  in `migration_map` so reruns update rather than duplicate. Each transaction must post what
  QuickBooks posted (true-up or journal entry fallback), and the tie-out must reach zero in
  tests. Tax ids, SSNs and bank/card numbers from QuickBooks are dropped before staging
  (`withoutSensitive`).
- Sales tax (ADR 0014): the calculation is `computeSalesTax` in `@acct/shared` (the web previews,
  the API recomputes through `SalesTaxCalculator`). Every posting that changes what an agency is
  owed also writes `sales_tax_lines` (`replaceSalesTaxLines`) so the liability ties to Sales Tax
  Payable. Rates are effective-dated; never change a single rate's percentage in place.
- Reports: add a report as a function `(scope, query) => ReportDto | GeneralLedgerDto`
  registered in `ReportsService.runners`, a key in `REPORT_KEYS` and an entry in the web
  catalog (`components/reports/catalog.ts`); exports, memorizing and schedules then work.
  Multi-column reports set `columnDrill` so every amount drills down. Custom report columns and
  filters map to fixed SQL expressions only.
- Payroll (ADR 0015, 0016): nothing in payroll code is a tax rate, wage base, deposit rule or
  taxability rule; those come from `tax-data` with citations. Anything the data doesn't source
  (`"status": "pending"`, or a kind missing from a state's `taxableWages`) is refused with a
  reason, never guessed. Add a tax figure by adding it to the tax file with its source, then a
  golden test from the publication's own example. Supported states are in `docs/states.md`
  (`PAYROLL_STATES`). SSNs and direct deposit account numbers are
  encrypted with row-bound AADs (`employee:<id>:ssn`,
  `employee_bank_account:<id>:account_number`), shown masked, never audited; ACH files are
  returned to the caller and never stored (only `ach_batches` metadata). Withholding
  certificates are effective-dated history: add a new one, never edit. Employees are terminated,
  not deleted. Paychecks store their input and are recalculated while draft; posting goes through
  `PostingService` ('paycheck' transactions) and posted paychecks are voided, never changed (DB
  triggers). Year to date comes from posted paychecks' tax lines. Payroll reports are served under
  `payroll/reports` with `payroll.view`, not the reports hub (they show individual pay).
- Database errors map to HTTP in `common/pg-error.filter.ts`; add friendly messages for new unique
  indexes there.

## Phase status

- [x] Phase 0: Foundation (monorepo, CI, auth + MFA, companies, users/roles, RLS, audit log, app shell)
- [x] Phase 1: Ledger core (chart of accounts, lists, journal entries, posting engine, TB/GL/P&L/BS)
- [x] Phase 2: Sales & A/R (invoices, payments, deposits, estimates, statements, A/R reports, cash basis)
- [x] Phase 3: Purchases & A/P (bills, pay bills, checks + printing, expenses, POs, vendor credits, 1099, A/P reports)
- [x] Phase 4: Banking (registers, transfers, reconciliation, file imports, bank rules, Plaid feeds)
- [x] Phase 5: Documents (library, attachments, versions, scanning, encrypted storage, receipt capture, email-in, retention)
- [x] Phase 6: QuickBooks migration (QBO connector + attachments, Desktop agent, IIF/CSV, Migration Report, Match attachments)
- [x] Phase 7: Reports suite, sales tax, budgets (columns/comparisons, cash flow, detail reports, custom builder, PDF/Excel/CSV, memorized + scheduled, sales tax, budgets)
- [x] Phase 8: Payroll core (setup, employees, tax engine with golden tests, pay runs, pay stubs, direct deposit, liabilities + EFTPS, payroll reports; tax data owner-approved, awaiting professional review)
- [ ] Phase 9: Payroll and 1099 tax forms
- [ ] Phase 10: Advanced (inventory, time, multi-currency, …)
- [ ] Phase 11: E-file and partners
- [ ] Phase 12: Hardening and launch
