# QuickBooks-Style Accounting & US Payroll Platform: Advice + Master Build Prompt

> Prepared 2026-09-29. Placeholder product name: **[PRODUCT_NAME]**. Pick a name of your own. Do not use "QuickBooks", Intuit logos, or copied UI assets anywhere in the product; matching the workflows is fine.

---

## PART A: What you should know before we start

### 1. "Restore a QuickBooks file": what is possible

| Source                                                 | Can we read it directly?                                                                                                | Realistic path                                                                                                                                                                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **QuickBooks Online (QBO)**                            | Yes, through Intuit's official API                                                                                      | Register an app at developer.intuit.com. The customer connects with OAuth. We pull every list and transaction through the Accounting API, and pull every attachment through the `Attachable` entity (download links). This is the cleanest path.            |
| **QuickBooks Desktop company file (.QBW)**             | **No.** It is a proprietary, encrypted database. Reverse engineering it is unreliable and may violate Intuit's license. | A small **Windows migration agent** (C#/.NET) runs on a PC where QuickBooks Desktop is installed. It opens the company file through Intuit's **QuickBooks SDK (qbXML / QBFC)** and uploads all lists and transactions to our cloud.                         |
| **QuickBooks Desktop backup (.QBB) / portable (.QBM)** | No                                                                                                                      | Restore it in a licensed copy of QuickBooks Desktop first, then run the migration agent.                                                                                                                                                                    |
| **IIF files, Excel/CSV report exports**                | Yes                                                                                                                     | Build importers for IIF, plus CSV/Excel for lists and GL detail. These are fallbacks for customers without an API or SDK route.                                                                                                                             |
| **Desktop attachments (Doc Center / "Attach" folder)** | Partly                                                                                                                  | The files sit in an `Attach` folder next to the company file. The SDK does not reliably show which transaction each file belongs to. So we import the folder, auto-match by filename and metadata, and give the user a manual matching screen for the rest. |

**Non-negotiable:** after every migration we compare the Trial Balance, Balance Sheet, and P&L for every year, plus AR/AP aging and bank balances, between QuickBooks and our system. The migration is not "done" until they tie out to the penny.

### 2. IRS payroll forms (941, 940, W-2, 1099): generating vs. e-filing

Generating the forms is straightforward. **E-filing them requires IRS/SSA authorization that only your company can obtain.** I can write the code, but I cannot get the approvals for you.

| Form                                    | Print / PDF                                                                                                         | Electronic filing route                                           | Your business prerequisite                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 941 (+ Schedule B), 940 (+ Sch. A), 944 | Fill the official IRS fillable PDFs                                                                                 | IRS **Modernized e-File (MeF)** for 94x forms                     | Apply via IRS e-Services as a **Software Developer / Transmitter** (and optionally Reporting Agent, Form 8655). Get an ETIN and pass IRS **ATS** testing. |
| W-2 / W-3                               | Print employee copies B, C, 2 on plain paper. **Copy A for the SSA must be the red-ink official form, or e-filed.** | **SSA EFW2** file uploaded through Business Services Online (BSO) | BSO account (easy)                                                                                                                                        |
| 1099-NEC / 1099-MISC / 1096             | Print recipient copies. Copy A must be the red form or e-filed.                                                     | IRS **IRIS** (the old FIRE system is being retired)               | IRIS Transmitter Control Code (TCC) for system-to-system filing. The IRIS portal CSV upload needs less setup.                                             |
| State wage reports / state W-2s / SUI   | State-specific PDFs and files                                                                                       | Each state has its own format and portal                          | Per-state registrations                                                                                                                                   |
| Tax deposits (941/940 liabilities)      | Payment reminders                                                                                                   | **EFTPS** (batch provider enrollment is separate)                 | EFTPS enrollment                                                                                                                                          |

**My recommendation:** v1 produces print-ready PDFs plus **upload-ready files** (EFW2 for SSA, IRIS CSV for 1099s) that the user submits in the government portals. v2 adds direct MeF, IRIS A2A, and EFTPS e-filing once your IRS approvals come through (the approvals often take months, so apply early).

**Recent law changes to handle (verify against current IRS guidance at build time):**

- The 2025 tax law (the "One Big Beautiful Bill Act") added W-2 reporting of **qualified tips and qualified overtime**.
- It raised the **1099-NEC/1099-MISC reporting threshold from $600 to $2,000** for payments made after 2025, indexed for inflation later.
- It restored the 1099-K threshold to $20,000 and 200 transactions.
- The Social Security wage base, Pub 15-T withholding tables, FUTA credit-reduction states, and state rates change **every year**. All of these must live in versioned data files, never hard-coded.

### 3. Multi-state payroll tax accuracy

Federal withholding (Pub 15-T), FICA, and FUTA are manageable to build in-house. **All 50 states plus thousands of local jurisdictions are not.** Payroll companies license a tax engine for this: **Symmetry Tax Engine** is the industry standard. The other option is an embedded payroll API (e.g., **Check**, **Gusto Embedded**), which also handles tax filing and deposits for you.

My recommendation: build federal in-house and design a `TaxEngine` interface. Start with federal plus a handful of states you actually need. Plug in Symmetry (or an embedded payroll provider) before selling nationwide.

**Direct deposit** requires either (a) a bank (ODFI) willing to accept **NACHA ACH files** from you, or (b) a payments/payroll provider. Either way, a regulated partner is required.

### 4. Downloading clients' bank transactions

- **Aggregators (automatic bank feeds):** **Plaid** (most common; Transactions Sync API), MX, Finicity (Mastercard), Yodlee, Akoya. Each requires production approval and a security review of your company.
- **File imports (no approval needed; build first):** **QBO / QFX / OFX** files ("Web Connect", which every US bank offers), **CSV** with column mapping, and optionally BAI2 for business banking.
- **Features:** a "For Review / Categorized / Excluded" workflow, bank rules, auto-match to existing transactions, duplicate detection, and reconciliation.

### 5. Security and compliance

You will store SSNs, bank account numbers, and bank credentials/tokens. Plan for:

- Field-level encryption of SSN, EIN, and bank numbers (cloud KMS)
- MFA
- Role-based access
- An immutable audit log
- Per-tenant data isolation (PostgreSQL Row-Level Security)
- Point-in-time backups

Regulations and standards that apply:

- FTC **GLBA Safeguards Rule**
- IRS **Pub 4557** (safeguarding taxpayer data)
- IRS **Pub 1345** (if you become an e-file provider)
- **SOC 2 Type II**, which banks, Plaid, and customers will ask for

Use Stripe (or similar) for card payments so you stay out of PCI scope.

### 6. Scope reality

Intuit built QuickBooks over 30+ years. A credible first product is achievable, but **build in phases**. Each phase should be a usable, tested product, with every phase ending in a working demo and tie-out tests. The phase plan below is ordered so you can use (and even sell) the product early:

- **Core ledger, AR/AP, and banking** come first.
- **QuickBooks migration** comes next.
- **Payroll** follows.
- **E-filing** comes last, once the approvals arrive.

### 7. Things only you (the business) can do. Start these now.

1. Intuit Developer account and app (QBO API). Production keys need Intuit's app assessment.
2. Plaid (or MX/Finicity) account and production application.
3. IRS e-Services account, then Software Developer/Transmitter application (ETIN), ATS testing, and an IRIS TCC.
4. SSA BSO account.
5. EFTPS batch provider enrollment (optional, v2).
6. ODFI bank or payroll-payments partner for direct deposit.
7. Symmetry Tax Engine license or an embedded-payroll partner (before multi-state launch).
8. A CPA / payroll specialist to review the tax logic and forms before go-live.
9. Cyber-liability insurance, SOC 2 readiness (e.g., Vanta/Drata), terms of service, privacy policy.

---

## PART B: MASTER PROMPT (paste this into a new Claude Code session)

> Copy everything between the lines into the first message of a new session on the new repository. Use the Phase Kickoff prompts in Part C for each later phase.

---

```
You are the lead architect and engineer for [PRODUCT_NAME], a cloud accounting and US payroll
platform for small and mid-sized US businesses and the accounting firms that serve them.
Functionally it should match QuickBooks (Online + Desktop Pro/Premier feature set) closely enough
that a QuickBooks user feels at home. It must be able to import a customer's complete QuickBooks
history, including attached documents. Do NOT use Intuit trademarks, logos, or copied UI assets.

=====================================================================
0. HOW YOU WORK (applies to every session)
=====================================================================
- Build in the phases listed in section 9, one phase (or sub-phase) per branch/PR. Do not start a
  phase until the previous one's acceptance criteria pass.
- At the start of the project, create CLAUDE.md with: stack, commands (dev, test, lint, migrate,
  seed), architecture rules from this prompt, and a "Phase status" checklist. Update it at the end
  of every phase.
- Also keep /docs/adr/ (architecture decision records) and /docs/phase-N.md (what was built, how
  to demo it, known gaps).
- Every feature ships with tests. Accounting and tax logic needs exhaustive unit tests plus golden
  tests against published IRS examples. Never mark something done when tests fail.
- MONEY: never use floating point. Store amounts as NUMERIC(19,4) in Postgres and use a decimal
  library in code (or integer cents). Rounding rules must be explicit and tested.
- Tax rates, wage bases, withholding tables, form layouts and thresholds live in versioned data
  files under /tax-data/<year>/ with a source citation (IRS publication + URL + revision date) in
  each file. Never hard-code them.
- When a tax, legal or accounting-policy question is ambiguous, stop and ask me. Do not guess.
  List these questions in /docs/open-questions.md.
- Prefer boring, proven technology. Explain any new dependency in an ADR.
- Keyboard-first, fast UI: accountants live in registers and forms. Every list and register must
  handle 100k+ rows (server pagination + virtualization).

=====================================================================
1. TECH STACK (propose changes in an ADR if you have strong reasons)
=====================================================================
- Monorepo (pnpm + Turborepo), TypeScript end-to-end, strict mode.
- Web app: Next.js (React) + TanStack Query + TanStack Table + a component library (shadcn/ui).
- API: NestJS (REST + OpenAPI spec; webhooks). Background jobs: BullMQ on Redis.
- Database: PostgreSQL 16+, migrations via Prisma or Drizzle; Row-Level Security for tenant
  isolation (every tenant-scoped table has company_id; RLS policies enforced).
- File storage: S3-compatible object storage, server-side encryption, pre-signed URLs, ClamAV
  virus scanning.
- PDF: pdf-lib to fill official IRS fillable PDFs; a React-to-PDF/HTML-to-PDF renderer for
  invoices, checks, pay stubs, reports.
- Auth: email+password with mandatory MFA (TOTP/WebAuthn), SSO later; sessions via secure cookies.
- Secrets & field encryption: cloud KMS envelope encryption for SSN, EIN/TIN, bank account
  numbers, aggregator tokens.
- QuickBooks Desktop migration agent: separate C#/.NET 8 Windows app using the QuickBooks SDK
  (QBFC/qbXML), code-signed installer.
- Infra: Docker, IaC (Terraform), CI on GitHub Actions (lint, typecheck, unit, integration with
  Postgres service container, Playwright e2e).
- Observability: structured logs (PII-redacted), OpenTelemetry traces, error tracking.

=====================================================================
2. ACCOUNTING CORE (the ledger is the heart; get it right first)
=====================================================================
Double-entry general ledger:
- Every business document (invoice, bill, check, paycheck, deposit, etc.) is stored as its own
  document record AND posts balanced journal lines (sum of debits = sum of credits, enforced by
  DB constraint/trigger and by service code).
- Posted entries are never hard-deleted. Edits create an audit record and re-post; void keeps the
  document with zero amounts; delete is a soft delete logged in the audit trail. Mirror QuickBooks
  behavior but keep a complete, immutable history.
- Closing date with separate closing password; posting into a closed period is blocked unless the
  user has the right role AND supplies the password; every exception is logged.
- Cash vs. accrual basis is a report-time choice (store accrual postings; derive cash basis).
- Idempotency keys on all create endpoints.
- Every row: created_by, created_at, updated_by, updated_at, source (manual/import/bank-feed/api).

Company & users:
- Multi-company per login (accountants manage many clients); company switcher.
- Company settings: legal name, DBA, EIN, address, fiscal year start, tax form (1120, 1120-S,
  1065, Schedule C), accounting basis default, feature toggles.
- Roles: Owner/Admin, Accountant (external), Standard (full/limited), Sales-only, Purchases-only,
  Payroll Admin, Time-tracking only, Reports only, custom roles with per-module permissions.
- Audit log UI: filter by user, date, entity; show before/after values.

Lists:
- Chart of Accounts using QuickBooks account types: Bank, Accounts Receivable, Other Current Asset,
  Fixed Asset, Other Asset, Accounts Payable, Credit Card, Other Current Liability, Long Term
  Liability, Equity, Income, Cost of Goods Sold, Expense, Other Income, Other Expense. Detail types,
  optional account numbers, unlimited sub-accounts, inactive flag, tax-line mapping.
- Customers with Jobs/Projects (hierarchical), Vendors (with 1099 flag, TIN, 1099 box mapping),
  Employees, Other Names.
- Items: Service, Inventory Part, Non-inventory Part, Other Charge, Subtotal, Group/Bundle,
  Discount, Payment, Sales Tax Item, Sales Tax Group, Inventory Assembly (later phase).
- Classes and Locations/Departments (tracking dimensions on every line), Terms, Payment Methods,
  Ship Via, Customer/Vendor types, Price Levels, custom fields.

Sales / Accounts Receivable:
- Estimates, Sales Orders, Invoices (incl. progress invoicing from estimates), Sales Receipts,
  Receive Payments (apply to multiple invoices, discounts, overpayments/credits), Undeposited
  Funds and Make Deposits, Credit Memos, Refund Receipts, Delayed Charges/Credits, Statements,
  Finance/late charges, recurring (memorized) transactions, customer portal/email with PDF, online
  payment links via Stripe.
- Customizable form templates (logo, fields, layout) for invoices, estimates, statements.

Purchases / Accounts Payable:
- Purchase Orders, Item Receipts, Bills, Pay Bills (select many, early-pay discounts), Checks
  (write, print on standard check stock with voucher; print queue; check number sequencing),
  Expenses, Credit Card Charges/Credits, Vendor Credits, recurring bills.
- 1099 tracking at the vendor + account/line level.

Banking:
- Account registers (QuickBooks-style running balance register with inline entry).
- Transfers, deposits, reconciliation (statement date/ending balance, check-off, difference must
  be 0.00, reconciliation report PDF, discrepancy report, undo last reconciliation with audit).
- Bank feeds: see section 5.

Other:
- Journal entries (multi-line, reversing entries, recurring, adjusting-entry flag).
- Sales tax: agencies, rates, combined rates, taxable/non-taxable customers & items, sales-tax
  liability report, Pay Sales Tax, adjustments. Design an interface for an external tax
  calculator (Avalara/TaxJar) later.
- Inventory: quantity on hand, FIFO or average cost (company setting), adjustments, reorder points,
  inventory valuation reports. Assemblies and multiple locations in a later phase.
- Time tracking: timesheets, billable time to invoices, feeds payroll.
- Budgets (by account/class/customer, monthly) and budget vs. actual.
- Multi-currency (later phase): home currency, exchange rates, realized/unrealized gains.
- Accountant tools: trial balance adjustments, reclassify transactions in bulk, write-off
  invoices, fix undeposited funds, closing workflow, "accountant review" of client changes.

Reports (all filterable by date range, basis, class, location, customer, vendor; drill-down from
any number to the transactions behind it; export to Excel/CSV/PDF; memorize & schedule by email):
- Profit & Loss (standard, detail, by class, by location, by month, vs. prior year, vs. budget),
  Balance Sheet (standard, detail, comparative), Statement of Cash Flows, Trial Balance, General
  Ledger, Journal, Transaction Detail by Account, Audit Log.
- A/R Aging summary/detail, Open Invoices, Customer Balance, Collections, Sales by Customer/Item.
- A/P Aging summary/detail, Unpaid Bills, Vendor Balance, Expenses by Vendor, 1099 Summary/Detail.
- Banking: Reconciliation, Deposit Detail, Check Detail, Missing Checks.
- Inventory: Valuation summary/detail, Stock status.
- Sales tax liability; Payroll reports (section 6).
- A custom report builder (choose columns, filters, grouping, subtotals).

=====================================================================
3. QUICKBOOKS MIGRATION ("restore my QuickBooks company")
=====================================================================
Goal: a customer's entire QuickBooks history, lists, open balances, attachments, and payroll YTD
arrive intact, and the books tie out to the penny.

3a. QuickBooks Online connector
- Intuit OAuth 2.0 app; store tokens encrypted; handle refresh.
- Pull ALL entities with paging: CompanyInfo, Preferences, Account, Class, Department, Term,
  PaymentMethod, TaxCode/TaxRate/TaxAgency, Customer, Vendor, Employee, Item, Estimate, Invoice,
  SalesReceipt, Payment, CreditMemo, RefundReceipt, Deposit, Transfer, Purchase, PurchaseOrder,
  Bill, BillPayment, VendorCredit, JournalEntry, TimeActivity, Budget, and Attachable.
- Download every attachment (Attachable -> download URL), store in our document store and link it
  to the same transaction/list record it was attached to in QBO. Keep the original filename,
  upload date and note.
- Support Change Data Capture for delta sync during a cut-over window.
- Map QBO IDs -> our IDs in a migration_map table (entity type, source id, target id) so reruns
  are idempotent.

3b. QuickBooks Desktop migration agent (Windows, C#/.NET, QuickBooks SDK)
- Installer + simple wizard: sign in to [PRODUCT_NAME], pick the open company file, choose years.
- Query every list and transaction type through qbXML/QBFC, including memorized transactions,
  price levels, custom fields, and payroll items/YTD (whatever the SDK exposes; document gaps).
- Stream to our API in batches over HTTPS with resume-on-failure and progress UI.
- Attachments: locate the company's Attach/Doc Center folder, upload all files, and auto-link them
  to transactions using any metadata available + filename heuristics; unmatched files go to a
  "Match attachments" screen where the user links them manually.
- .QBB/.QBM backups: instruct the user to restore in QuickBooks Desktop first, then run the agent.
- Never attempt to parse the proprietary .QBW binary format.

3c. File-based importers (fallbacks, also useful for other systems)
- IIF import (lists and transactions).
- CSV/Excel importers with column mapping and preview for: chart of accounts, customers, vendors,
  items, employees, opening balances, journal entries, invoices, bills, and General Ledger detail.

3d. Validation & tie-out (required, automated)
- After import, generate a Migration Report comparing source vs. target for every fiscal year:
  Trial Balance by account, Balance Sheet, P&L, AR aging by customer, AP aging by vendor, bank
  and credit-card balances, inventory quantity/value, sales tax liability, payroll YTD by employee.
- Any difference is flagged with drill-down to the transactions causing it. The import is not
  marked "complete" until the differences are zero or the user explicitly accepts them.

=====================================================================
4. DOCUMENTS & SUPPORTING FILES
=====================================================================
- Attach any number of files to any transaction, list record (customer, vendor, employee,
  item), reconciliation, pay run, or tax filing. Also a company-wide document library with folders.
- Upload: drag & drop, multi-file, mobile camera capture, and a unique email-in address per
  company (forward receipts/bills).
- Accepted: PDF, images (JPG/PNG/HEIC -> converted), Office docs, CSV, TXT, ZIP; size limits
  configurable; virus scan before availability.
- Receipt/bill capture: OCR + AI extraction of vendor, date, total, tax, line items; propose a
  draft expense or bill for the user to confirm; learn from corrections.
- Versioning (never overwrite), full-text search, tags, preview in-browser, bulk download (ZIP).
- Retention policy settings (default keep 7 years; payroll/employment tax records at least 4
  years after the tax is due or paid); deletion requires Admin and is audit-logged.
- Files are encrypted at rest; access only via short-lived pre-signed URLs after permission check.

=====================================================================
5. BANK FEEDS & BANK DATA IMPORT
=====================================================================
- Provider abstraction `BankDataProvider` with a Plaid implementation first (Link, Transactions
  Sync, webhooks, re-auth handling); design so MX/Finicity/Yodlee can be added.
- File import: QBO (Web Connect), QFX, OFX (1.x SGML and 2.x XML), CSV with saved column mappings
  per bank, date-format detection, debit/credit or signed-amount columns.
- Map each connected/imported account to a Bank or Credit Card account in the chart of accounts.
- "For Review / Categorized / Excluded" workflow:
  - Auto-match to existing unreconciled transactions (amount, date window, payee, check number).
  - Bank rules (conditions on description/amount/account -> payee, account, class, memo, split);
    rule priority; auto-add option.
  - Suggest categories from history; batch accept.
  - Duplicate detection across feed + file imports (bank transaction id / FITID + fuzzy).
- Transactions accepted from the feed post to the ledger like any other transaction and are
  linked to the raw bank record for audit.
- Reconciliation can pre-check transactions that cleared in the feed.

=====================================================================
6. US PAYROLL
=====================================================================
Setup:
- Employer: FEIN, filing requirements (941 vs 944), deposit schedule (monthly / semiweekly,
  lookback-period calculation), state registrations (withholding account #, SUI account # and
  rate, local taxes), workers' comp classes.
- Employees: personal info (SSN encrypted), hire/termination dates, work & residence locations,
  Form W-4 (2020+ version fields: filing status, multiple jobs, dependents amount, other income,
  deductions, extra withholding, exempt), state withholding certificates, pay type (hourly/salary/
  commission), pay schedule, direct-deposit accounts (split allowed), PTO policies, garnishments.
- Contractors (1099) with W-9 capture (TIN, TIN type, backup withholding).
- Payroll items: regular, overtime, double-time, salary, bonus, commission, tips (cash/charged),
  PTO/sick/holiday, reimbursements, fringe benefits; pre-tax deductions (401(k), 403(b), Section
  125, HSA, FSA, dependent care) with correct FIT/FICA/FUTA/state taxability per item; post-tax
  (Roth, garnishments with federal CCPA limits, loans); employer contributions (match, health).

Pay runs:
- Regular, off-cycle, bonus, and termination checks; manual checks; void/reissue.
- Hours entry grid + import from time tracking; salary auto-fill.
- Tax calculation via a pluggable `TaxEngine` interface:
  - Federal implementation in-house: FIT per IRS Pub 15-T (percentage method, automated payroll
    systems) including pre-2020 W-4 handling, Social Security (rate + annual wage base), Medicare
    + Additional Medicare over $200,000, FUTA (6.0% less 5.4% credit, first $7,000, credit-
    reduction states), supplemental wage rules (22% / 37% over $1M).
  - State/local: start with the states I list in /docs/states.md; the interface must allow a
    licensed engine (Symmetry Tax Engine) or an embedded payroll provider to be plugged in later.
  - Track the newer reporting items: qualified tips and qualified overtime amounts for W-2
    reporting per current IRS guidance.
- Preview -> approve -> post: posts wages, taxes, deductions and liabilities to the GL with a
  configurable payroll-to-GL mapping; creates paychecks (printed checks and/or direct deposit).
- Direct deposit: generate NACHA-formatted ACH files behind a `PaymentRail` interface (bank ODFI
  file upload or payroll-payments partner API). Pre-notes optional.
- Pay stubs (PDF + employee self-service portal) with current/YTD, PTO balances.

Liabilities & deposits:
- Track every tax liability by agency and due date from the deposit schedule; 100,000 next-day
  deposit rule alert; "Pay liabilities" screen; record payments (EFTPS confirmation #).
- Design an `EFTPSProvider` interface for a later batch-provider integration.

Payroll reports:
- Payroll summary/detail, employee earnings, tax liability, deductions/contributions, workers'
  comp, PTO, payroll journal, 941/940 worksheets, state wage reports, total cost of labor.

=====================================================================
7. TAX FORMS: GENERATE, PRINT, FILE
=====================================================================
All forms are computed from posted payroll/AP data, shown for review with line-by-line drill-down,
locked after filing (amendments via corrected forms), and archived as PDF with the filing record.

Federal payroll:
- Form 941 + Schedule B (quarterly), Form 944 (annual), Form 940 + Schedule A (annual),
  Form 941-X / 940 amended where needed. Fill the official IRS fillable PDFs for the tax year.
- Validation rules: 941 line 12 vs. total deposits, Schedule B totals = line 12 for semiweekly
  depositors, 940 line 13 vs. deposits, etc.

Year-end:
- W-2 (all boxes incl. box 12 codes, box 13, box 14, state/local boxes 15-20) and W-3.
  Print Copies B, C, 2 (and employer copy D) on plain paper; W-2 Copy A only via e-file or
  official red forms (print alignment for pre-printed stock).
- W-2c/W-3c corrections.
- 1099-NEC, 1099-MISC (and design for 1099-INT/DIV later), 1096; apply the current reporting
  threshold from /tax-data; recipient copies printable and deliverable electronically with
  consent; TIN matching hook.

Electronic filing (built behind interfaces; phase 1 = files for the user to upload, phase 2 =
direct transmission once the company holds IRS/SSA credentials):
- W-2: SSA EFW2 fixed-width file (RA/RE/RW/RS/RT/RU/RF records), validated with SSA AccuWage
  rules; user uploads via SSA BSO.
- 1099: IRIS format (CSV for portal upload in phase 1; IRIS A2A XML in phase 2 with TCC).
- 94x: IRS MeF XML schemas for 941/940/944 (phase 2, requires ETIN + ATS pass). Include an ATS
  test-scenario harness.
- State: quarterly SUI wage reports and state W-2 files for the supported states.
- Keep a filing log: form, period, status (draft, reviewed, filed, accepted, rejected), submission
  ID, acknowledgment, who filed, PDF/copy of what was submitted.

=====================================================================
8. SECURITY, PRIVACY, COMPLIANCE, RELIABILITY
=====================================================================
- Tenant isolation with Postgres RLS + tests that prove cross-tenant access is impossible.
- MFA required; session timeout; device/IP login alerts; password policy per NIST 800-63B.
- Field-level encryption (KMS) for SSN, TIN/EIN, bank/routing numbers, aggregator & Intuit
  tokens; mask in UI (***-**-1234) with reveal permission + audit.
- PII never in logs; structured log redaction tested.
- Immutable audit log for every create/update/delete/void/view-of-sensitive-field.
- Align with FTC GLBA Safeguards Rule, IRS Pub 4557, and IRS Pub 1345 (for e-file), and prepare
  for SOC 2 Type II (policies in /docs/security/).
- Backups: continuous (PITR), tested restore runbook; per-company export ("download my data"
  to CSV/JSON + all attachments) and company-level backup/restore inside [PRODUCT_NAME].
- Rate limiting, OWASP ASVS checks, dependency scanning, secret scanning in CI.

=====================================================================
9. PHASE PLAN (each phase = demoable, tested, documented)
=====================================================================
Phase 0 - Foundation: monorepo, CI, auth + MFA, companies, users/roles, RLS, audit log,
          design system and app shell (nav, company switcher, keyboard shortcuts), CLAUDE.md.
Phase 1 - Ledger core: chart of accounts, lists (customers, vendors, items, classes, locations,
          terms), journal entries, posting engine, closing date, Trial Balance, GL, P&L, Balance
          Sheet with drill-down.
Phase 2 - Sales & A/R: estimates, invoices, sales receipts, payments, undeposited funds,
          deposits, credit memos, refunds, statements, templates, email/PDF, A/R reports.
Phase 3 - Purchases & A/P: POs, bills, pay bills, checks + check printing, expenses, credit
          cards, vendor credits, 1099 tracking, A/P reports.
Phase 4 - Banking: registers, transfers, reconciliation, file imports (QBO/QFX/OFX/CSV), bank
          rules, For-Review workflow; then Plaid live feeds.
Phase 5 - Documents: attachments everywhere, document library, email-in, OCR/AI receipt capture.
Phase 6 - QuickBooks migration: QBO connector (incl. attachments), IIF/CSV importers, Desktop
          agent, attachment matching UI, automated tie-out Migration Report.
Phase 7 - Reports suite completion + custom report builder, memorized/scheduled reports,
          sales tax module, budgets.
Phase 8 - Payroll core: setup, employees, W-4, payroll items, federal tax engine, pay runs,
          GL posting, pay stubs, liabilities, NACHA file, payroll reports.
Phase 9 - Payroll & 1099 forms: 941/Sch B, 944, 940/Sch A, W-2/W-3, 1099-NEC/MISC/1096 PDFs,
          EFW2 + IRIS files, first supported states' SUI/withholding reports.
Phase 10 - Advanced: inventory costing + assemblies, time tracking, multi-currency, progress
          invoicing, accountant tools, customer payments via Stripe, employee/contractor portals.
Phase 11 - E-file & partners: MeF 94x transmission + ATS harness, IRIS A2A, EFTPS, licensed state
          tax engine or embedded payroll, direct-deposit partner.
Phase 12 - Hardening: performance (100k+ transactions/company), load tests, security review,
          SOC 2 controls, disaster-recovery drill, launch checklist.

Acceptance criteria for every phase:
- All tests green in CI; coverage >= 90% on ledger, tax and form modules.
- Property-based test: any sequence of document create/edit/void keeps the ledger balanced and
  report totals consistent (TB debits = credits; BS assets = liabilities + equity; P&L net income
  = change in retained earnings/current-year earnings).
- Seeded demo company ("Sample Landscaping Co.") exercising every feature of the phase.
- /docs/phase-N.md with a demo script and screenshots (Playwright).

=====================================================================
10. START NOW
=====================================================================
1. Summarize your understanding in <= 20 bullets and list any questions blocking Phase 0.
2. Propose the repository structure and the core data model (ERD in Mermaid) for Phases 0-2,
   including how documents post to the ledger.
3. After I confirm, implement Phase 0, open a PR, and stop for review.
```

---

## PART C: Phase kickoff prompts (use one per new session)

**Every phase after 0:**

```
Read CLAUDE.md, /docs/adr/, the previous /docs/phase-*.md files and /docs/open-questions.md.
We are starting Phase <N> - <name> from the master plan in CLAUDE.md. First, list the exact scope,
the data-model changes, and the test plan, and ask any blocking questions. Then implement on a new
branch, keep all existing tests green, update the seed/demo company, write /docs/phase-<N>.md,
update the Phase status checklist in CLAUDE.md, and open a PR.
```

**QuickBooks migration (Phase 6) extra:**

```
I will provide: (a) QBO sandbox credentials from my Intuit Developer account, (b) a sample
QuickBooks Desktop company exported via the agent, IIF and CSV files, and (c) an Attach folder.
Build the importers so that the Migration Report ties out to zero on these samples, and add those
samples (with any PII scrubbed) as regression fixtures.
```

**Payroll tax (Phases 8-9) extra:**

```
Before coding, create /tax-data/<current year>/federal.json with every rate, wage base, threshold
and Pub 15-T table needed, each with its IRS source URL and revision date, and show it to me for
verification. Build golden tests from the worked examples in Pub 15-T and the form instructions.
Supported states for now: <list your states>.
```

---

## PART D: Information to gather before we begin

1. Product name, and whether this is for **your own firm's clients** only or a **SaaS you will sell**. Selling it raises the compliance bar (SOC 2 and e-file approvals).
2. Which QuickBooks editions your clients use (Online, Desktop Pro/Premier/Enterprise, Accountant), and a sample file or sandbox to test against.
3. Which states you need for payroll first.
4. Roughly how many clients, employees per client, and transactions per year.
5. Whether you want direct deposit and tax deposits handled **by the software** (needs a partner) or **by the client** (the software just produces files and reminders).
6. Cloud preference (AWS / Azure / GCP) and whether you have an existing stack you want reused.
