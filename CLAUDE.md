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
pnpm db:migrate                 # applies packages/db/migrations/*.sql as the owner, then installs the job queue
pnpm db:seed                    # demo user + "Sample Landscaping Co." (prints MFA secret)
pnpm dev                        # API :4000 + web :3000 (web proxies /api -> API); the API runs jobs too
pnpm --filter @acct/api worker  # a separate job worker (production runs the API with JOB_WORKER=off)

pnpm lint && pnpm typecheck && pnpm test   # all unit/integration tests (need Postgres)
pnpm e2e                        # Playwright; needs `pnpm build` first, ports 3000/4000 free
pnpm --filter @acct/api perf     # performance suite (needs `nest build`); PERF_SCALE=full for 100k transactions
pnpm --filter @acct/api keys:status|keys:rotate|keys:reencrypt   # field keys (ADMIN_DATABASE_URL, ADR 0029)
pnpm format                     # prettier
```

A single package: `pnpm --filter @acct/api test`, `pnpm --filter @acct/db test`, etc.

## Layout

- `apps/api`: NestJS 11 REST API (Express 5). Modules: auth, companies, members, audit, mail, health
  (`/health/live`, `/health/ready`), jobs (the pg-boss queue in `jobs/job-queue.service.ts`, the
  job catalogue in `jobs/jobs.ts`, `worker.ts` the worker entry), observability (redacted JSON
  logs in `observability/logger.ts`, redaction in `redact.ts`, OpenTelemetry in `tracing.ts`),
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
  payroll reports in `payroll-reports.ts`; a licensed state and local tax engine behind
  `StateTaxEngine` in `payroll/tax/state-tax-engine.ts`; EFTPS as batch provider and the direct deposit
  partner behind `EftpsBatchProvider` and `DepositPartner` with stand-ins in `payroll/partners/`
  (`eftps.service.ts`, `deposit-partner.service.ts`, the poller in `partners-poller.service.ts`);
  tax forms in `payroll/forms/` (pure builders over pay
  records) served by `tax-forms.service.ts`, prior payroll in `prior-payroll.service.ts`, filing
  records in `tax-filings.ts`), inventory (costing in `inventory/costing.ts` (pure),
  `InventoryService` for movements and recosting, adjustments, builds and starting values in
  `inventory-documents.service.ts`, reports in `reports/inventory-reports.ts`), time (entries,
  weekly timesheets and approvals in `time/time.service.ts`; progress invoicing in
  `sales/progress.ts`; reports in `reports/time-reports.ts`), currency (settings, currencies and
  rates in `currency.service.ts`, the European Central Bank behind `ExchangeRateProvider` in
  `currency/rates-provider.ts`, document helpers in `currency/fx.ts`, revaluation in
  `revaluation.service.ts`), accountant (reclassify, write off invoices, fix undeposited funds,
  client change review and the month-end close checklist, one service each in `accountant/`),
  online-payments (Stripe Connect behind `PaymentProcessor` with a stand-in in
  `online-payments/processors/`; settings and pay links in `online-payments.service.ts`, the
  customer's pay page in `public-pay.service.ts`, webhooks to payments and payout deposits in
  `payment-events.service.ts`), portals (employee and contractor portal in
  `worker-portal.service.ts` behind `WorkerPortalGuard`, invitations and change requests in
  `portal-admin.service.ts`, the customer portal and its sessions in `customer-portal.service.ts`),
  efile (Forms 941/940 through MeF and Forms 1099 through IRIS behind `EfileTransmitter`, a
  stand-in in `efile/transmitters/`; submissions and acknowledgements in `efile.service.ts`, the
  returns and pre-send checks in `efile-returns.ts`, the ATS harness in `efile/ats/` with
  scenarios in `/efile-ats/<year>/`), security (field keys wrapped by KMS in `field-keys.ts`,
  every AAD in `aad.ts`, the encrypted-column registry and rotation in `rotation.ts`, the
  `keys:*` CLI), data-export (the owner's full archive: rules in `archive.ts`, the job in
  `data-export.service.ts`). Sign-in hardening lives in `auth/` (`recent-mfa.guard.ts` for
  step-up, `security-notices.service.ts`, `breach-check.ts`, `credential-cleanup.service.ts`).
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
  golden test from the publication's own example. The built-in engine's states are in
  `docs/states.md` (`PAYROLL_STATES`); employees and registrations accept any state
  (`PAYROLL_WORK_STATES`), whose taxes come only from a licensed `StateTaxEngine` (ADR 0026).
  SSNs and direct deposit account numbers are
  encrypted with row-bound AADs (`employee:<id>:ssn`,
  `employee_bank_account:<id>:account_number`), shown masked, never audited; ACH files are
  returned to the caller and never stored (only `ach_batches` metadata). Withholding
  certificates are effective-dated history: add a new one, never edit. Employees are terminated,
  not deleted. Paychecks store their input and are recalculated while draft; posting goes through
  `PostingService` ('paycheck' transactions) and posted paychecks are voided, never changed (DB
  triggers). Year to date comes from posted paychecks' tax lines. Payroll reports are served under
  `payroll/reports` with `payroll.view`, not the reports hub (they show individual pay).
- Payroll tax forms (ADR 0017): every form is built from pay records (posted paychecks plus prior
  payroll, by pay date) by pure functions in `payroll/forms/`, with golden tests from the form
  instructions' own examples. Box and line rules follow the supplied instructions; figures and
  due dates live in `tax-data`. Prior payroll counts toward year-to-date wage bases but never
  posts to the books, and is locked once a filed form covers it. A filing keeps a snapshot of its
  figures (no SSNs); later differences are listed, never silently absorbed. Exports with full SSNs
  are POSTs needing `payroll.sensitive.reveal`, are never stored, and are audited without SSNs.
- Inventory (ADR 0018): anything that changes a quantity plans its movements through
  `InventoryService.plan()` before posting, appends the plan's inventory lines (journal lines with
  `role = 'inventory'`) to its own, posts once, then calls `commit(txnId)`. Voids and deletes plan
  with no movements. Never write `inventory_moves` or inventory lines directly: `commit` recosts
  later transactions through `PostingService.replaceRoleLines`. Stock never goes below zero on any
  date. The inventory asset accounts must equal the value on hand (tests check it). The costing
  method is fixed once inventory has moved. Items converted to inventory (the QuickBooks cut-over)
  are tracked from `inventory_start_date`: documents dated earlier post as they did, with no
  quantities.
- Time and progress invoicing (ADR 0019): only approved time is paid (regular pay runs link it
  to the paycheck) or billed (invoice lines carry `timeEntryIds`); submitted and approved time is
  locked, and used time can't be unapproved. Approval needs `time.approve` or being the
  employee's manager. What an estimate line has invoiced is always computed from posted invoice
  lines (`estimate_id`, `estimate_line_no`); call `refreshEstimate` after anything that changes
  them.
- Multi-currency (ADR 0020): the home currency is US dollars and journal lines are always in
  dollars. A foreign-currency document keeps its amounts in the party's currency
  (`transactions.total`, `currency`, `exchange_rate`, `home_total`) and converts line by line
  (`toHome`); its control line (A/R or A/P in the currency) is the sum of the converted lines and
  carries `foreign_debit`/`foreign_credit`. Get the currency and rate with `documentCurrency` and
  the control account with `controlAccount` (`currency/fx.ts`), never `systemAccount`, for A/R
  and A/P. Payment applications of foreign payments store `home_amount` (`relievedHome`); the
  difference from the money moved is the realized gain or loss. Anything that reads document
  totals as money in the books uses `home_total` (or `round(amount * exchange_rate, 2)` per
  line). Open items must tie to each control account in dollars and in the currency (tests
  check both). Rates are exact (`parseRate`), never numbers.
- Accountant tools (ADR 0021): reclassifying changes only accounts and classes, through
  `PostingService.reclassifyLines` (a new version, amounts unchanged, closing date guarded), and
  rewrites the matching `sales_lines`/`purchase_lines` using `documentLines` (journal line 1 is
  the total, then one per non-zero document line in order). If a document's posting order
  changes, update `documentLines` and its tests. A/R, A/P, bank, card, sales tax, payroll and
  inventory lines never move. Write-offs and undeposited-funds fixes go through the sales
  services' `saveInTx`. Client changes are read from `audit_log` (reviews in `audit_reviews`,
  never an audit update). The close checklist is computed live; closing goes through
  `LedgerSettingsService.updateInTx` and appends to `period_closes`.
- Online payments (ADR 0022): processors are reached only through `PaymentProcessor` (Stripe over
  REST, the stand-in for development and tests; tests never call the network). Webhooks are
  verified by the processor and recorded in `payment_events` in the same transaction as their
  effect (handled once). Successful payments become Receive Payments into Undeposited Funds
  through `PaymentsService.saveInTx`; each payout becomes one deposit through
  `DepositsService.saveInTx` that must equal the payout, or it waits for review (never guess).
  Pay links store only a token hash; public routes find the company through the
  security-definer lookups and then use `withTenant()`.
- Portals (ADR 0023): employees and contractors are users linked to their record through
  `portal_links`, never members; company routes stay closed to them (404). Portal routes
  (`portal/c/:companyId`) prove the record is the person's own, then call the normal services
  with `portalCompanyContext` granting only the permission that call needs; the worker comes
  from the link, never the request. Employees change their W-4 or direct deposit only through
  `employee_change_requests` that a payroll admin approves (bank numbers encrypted with the
  request's AAD, applied through `EmployeesService`, prenoted). Customers use emailed one-time
  links and their own session cookie; every customer query is scoped to the session's customer.
- Electronic filing (ADR 0024): returns reach the IRS only through `EfileTransmitter` (the
  stand-in until the MeF and IRIS transmitters exist; tests never call the network). A
  submission is committed as `sending` before the transmitter is called, then `transmitted`,
  `failed`, or left `sending` when the answer is unknown. One per form and period can be in
  flight. The returns carry the full EIN and TINs, decrypted only to build them and never stored
  or logged; submissions keep a snapshot without them. An accepted production return records its
  `tax_filings` row (method electronic), which can't be voided; a rejected one is fixed and sent
  again. Forms 1099 have filing records too (`form_1099`, purchases permissions, never covering
  payroll). The ATS harness only sends to a transmitter in the test environment.
- EFTPS and the direct deposit partner (ADR 0025): both are reached only through their
  interfaces (stand-ins until the Treasury enrollment and a partner contract exist; tests never
  call the network). An EFTPS payment of an enrolled company is recorded and posted as `sending`
  through `PayrollLiabilitiesService.payInTx`, committed, then sent; it becomes `scheduled`, or is
  voided when refused, cancelled or returned (never voided directly while scheduled). A partner
  batch and its `direct_deposit_entries` are written as `sending` before the partner is called;
  one per pay run unless it failed. Returns flag the paycheck and turn the account off
  (`employee_bank_accounts.returned_at`) and post nothing. The EIN and account numbers are
  decrypted only to build requests; enrollment accounts use the AAD
  `eftps_enrollment:<id>:account_number`. `payroll_settings.deposit_rail` picks the NACHA file or
  the partner.
- Licensed state tax engine (ADR 0026): states outside `PAYROLL_STATES` are calculated only by a
  `StateTaxEngine` (`payroll/tax/state-tax-engine.ts`); with none (`PAYROLL_TAX_ENGINE=none`,
  the only production value until one is contracted) their paychecks are refused with the
  reason. There is no stand-in: never invent a state or local tax figure, even for a demo. Tests
  use `FixtureStateTaxEngine` (`test-fixture`, NODE_ENV=test only) and program its figures.
  Every answer goes through `checkStateTaxAnswer`; requests never carry an SSN or bank number.
  `state_other`, `local_income` and `local_other` lines name their jurisdiction and are owed to
  `state_other:<ST>:<code>` and `local:<ST>:<code>`; federal taxes stay built in.
- Background jobs (ADR 0027): anything that runs outside a request goes through `JobQueue`; never
  `setInterval`, `setImmediate` or fire-and-forget promises (QuickBooks imports are the one
  exception for now, question 85). Add a job to `jobs/jobs.ts` (cron in
  UTC for scheduled ones), register its handler in the owning service's `onModuleInit`, and
  `jobs:install` creates its queue. Job data carries ids only (never secrets, SSNs, bank numbers
  or figures). Cross-company jobs find companies through security-definer lookups returning ids,
  then work inside `withTenant()`. Pass `tx` to `send` when the job must exist only if the change
  commits. Tests run jobs inline (`JOB_QUEUE=inline`, `drain()`); job tests use real pg-boss.
- Logging (ADR 0027): use Nest's `Logger`; the app's `JsonLogger` redacts and tags every line
  with the request, user, job and trace ids. Never log bodies, headers, query strings or
  sensitive values; redaction is a safety net, not permission. Traces leave the process only
  through `RedactingExporter`.
- Database errors map to HTTP in `common/pg-error.filter.ts`; add friendly messages for new unique
  indexes there.
- Performance (ADR 0028): pages that grow with a company's history must not read every row into
  Node. Page, filter and total in SQL (see `registerPage`, `ledgerNets`, `openItems` with
  `openOnly`), and look up names only for the rows shown. Saving one record must not load the
  whole list. Check a new report or list against the 100,000-transaction company
  (`PERF_SCALE=full PERF_DB_NAME=acct_perf pnpm --filter @acct/api perf` keeps the data for
  reruns) and add it to `perf/perf.perf.ts`. App connections run with `jit=off`.
- Security (ADR 0029, checklist in `docs/security/asvs-l2.md`): the standard is OWASP ASVS
  Level 2.
  - **Encrypted columns:** a new one gets its AAD builder in `security/aad.ts` and an entry in
    `ENCRYPTED_COLUMNS` (a test checks the registry against the schema), so key rotation
    rewrites it. Name it `*_enc`; if the company owns the value, add it to `SENSITIVE_COLUMNS`
    in `data-export/archive.ts` so exports decrypt and mask it.
  - **Sensitive actions** (revealing or changing SSNs, EINs or bank numbers, members and roles,
    money movement set-up, exports with full numbers) use `@RequireRecentMfa()`.
  - **Data export:** new tables with a `company_id` are exported automatically. Credentials and
    staging go in `EXCLUDED_TABLES`; columns named `*_hash`, `*_enc`, `*token` or `*secret` are
    never exported.
  - **Outputs:** CSV cells go through `safeCell`. Downloads use `withSafeExtension` and
    `contentDisposition`.
  - **Inputs:** request bodies are JSON, raw files (`application/octet-stream`) or MIME
    (`message/rfc822`); anything else is a 415. Parsers of untrusted text must run in linear
    time: no lazy `[\s\S]*?` scans to a closing tag.
  - **Outbound fetches** to URLs that come from a provider check the host, refuse redirects
    and cap the size.
  - **Logging:** log refused or suspicious requests with `securityEvent` (ids and field paths
    only).
  - **Production config:** settings that would be unsafe in production are refused in
    `loadConfig` (TLS, https, KMS, pepper, JSON logs).
  - **Web:** the CSP (`apps/web/src/proxy.ts`) allows scripts only with the page's nonce. Add a
    new external script or frame origin there deliberately.

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
- [ ] Phase 9: Payroll and 1099 tax forms (part 1 done: prior payroll, W-2/W-3 figures, quarterly and FUTA summaries, state reports, filings; official PDFs, EFW2, 1099/IRIS and state layouts wait on documents)
- [x] Phase 10: Advanced, in six parts (10a inventory done: items and assemblies, FIFO/average costing with backdated recosting, no negative stock, adjustments, builds, valuation and stock status reports, QuickBooks cut-over; 10b time tracking done: timesheets, approvals, paychecks and invoices from approved time, progress invoicing; 10c multi-currency done: foreign-currency customers, vendors, documents and payments, rates by hand or from the ECB, realized and unrealized gains and losses; 10d accountant tools done: reclassify, write off invoices, fix undeposited funds, client change review, month-end close, Adjusted Trial Balance; 10e online payments done: Stripe Connect Standard accounts (stand-in until the platform's keys exist), pay links and the pay page, payments into Undeposited Funds, payouts as deposits net of fees, refunds and chargebacks; 10f portals done: employee and contractor portals with password and MFA (pay stubs, W-2 figures, own time, W-4 and direct deposit requests approved by payroll, contractor payments and 1099 totals), customer portal by emailed link (invoices, statement, paying online, accepting estimates); follow-ups are open questions 62, 64, 66–69 and 71–73)
- [ ] Phase 11: E-file and partners, in three parts (11a electronic filing done: Forms 941 and 940 through MeF and Forms 1099 through IRIS behind `EfileTransmitter`, with a stand-in for the IRS until the platform's approvals exist, rejections fixed and sent again, accepted returns recorded as filings, the ATS harness; 11b partners done: EFTPS through the platform as batch provider (enrollment, scheduled payments booked when scheduled and voided when cancelled or returned) and direct deposit through a payments partner (per company, returns flag the paycheck and account), both with stand-ins; 11c tax engine plug-in done: any state can be set up, its state and local taxes come from a licensed engine behind `StateTaxEngine` (paychecks refused with the reason until one is contracted; no stand-in), jurisdictions through liabilities, W-2 boxes 14–20 and state quarterly; the embedded provider designed in ADR 0026; follow-ups are open questions 74–83)
- [ ] Phase 12: Hardening and launch, in four parts (12a jobs and observability done: a pg-boss queue in Postgres with a separate worker for receipt reading, the pollers, scheduled reports, a daily document purge and a nightly bank download; redacted JSON logs with request, user, job and trace ids; OpenTelemetry tracing with scrubbed spans; live and ready health checks; 12b performance done: a 100,000-transaction generator, a perf suite for reads, posting, 50-user load and shutdown (smoke in CI, full nightly), SQL paging and filtering for registers, subledger reports and P&L columns, jit off, draining requests on shutdown; 12c security done: AWS KMS envelope keys with rotation, an OWASP ASVS Level 2 review and fixes (sign-in, sessions, step-up, access, files, headers, CSP, errors, business logic, retention), CodeQL, dependency and secret scanning in CI, the owner's full data export, SOC 2 policies with placeholders; 12d launch on AWS; follow-ups are open questions 84–99)
