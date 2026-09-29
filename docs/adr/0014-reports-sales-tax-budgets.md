# ADR 0014: Reports suite, sales tax and budgets (Phase 7)

- Status: Accepted
- Date: 2026-09-29

## Context

Phase 7 of the master plan completes the reports and adds three features that feed them:

- **The rest of the reports:**
  - Profit and Loss by month, class, location, customer and vendor, compared with the prior year,
    and against a budget.
  - Balance Sheet detail and comparative.
  - Statement of Cash Flows, Journal, Transaction Detail by Account.
  - Collections, 1099 detail, Deposit Detail, Check Detail, Missing Checks.
  - Sales tax liability.

  Every report is filterable, drills down, and exports to Excel, CSV and PDF.

- **Memorized and scheduled reports**, and a **custom report builder** (columns, filters,
  grouping, subtotals).
- **Sales tax:** agencies, rates, combined rates, taxable and non-taxable customers and items, the
  liability report, Pay Sales Tax and adjustments, with room for an external calculator
  (Avalara, TaxJar) later.
- **Budgets** by account, class or customer, monthly, and Budget vs. Actuals.

## Decision

### Sales tax

- **Agencies and rates:**
  - An agency has a filing frequency (monthly, quarterly, annually) and its account number.
  - A **single rate** is owed to one agency. Its percentage is **effective-dated**
    (`tax_rate_values`), so a rate change never alters a document already dated.
  - A **combined rate** is a set of single rates; its percentage is their sum on the document
    date.
- **On documents:** invoices, sales receipts, credit memos, refund receipts and estimates carry
  the rate charged (`tax_rate_id`). Each line's `taxable` flag comes from the product/service
  unless set on the line.
- **Calculation:**
  - Each component is charged on the taxable total and rounded half away from zero to the cent,
    as QuickBooks does.
  - An exempt customer is charged nothing.
  - A person may enter the tax total (copying a paper invoice). It is then split across the
    components in proportion to their rates, the remainder going to the largest.
  - The calculation lives in `@acct/shared` (`computeSalesTax`): the web previews exactly what
    the API charges, and the API recomputes it.
- **The calculator** is an interface (`SalesTaxCalculator`) with the rate table as the only
  implementation. An external service can replace it; the request already carries the customer
  and item ids.
- **Posting:**
  - The tax is a credit to Sales Tax Payable per component, on the income side, posted through
    `PostingService` (ADR 0007).
  - Credit memos and refunds reverse it.
  - A/R and cash-basis recognition (ADR 0009) treat it like any other line of the document.
- **Per agency:** `sales_tax_lines` records what each posted transaction did to each agency's
  liability:
  - tax charged (+);
  - tax given back (−);
  - payments (−);
  - adjustments (±).

  It is current-state detail, replaced on save like `sales_lines`. What is owed to an agency is
  the sum of its lines on posted transactions. A void drops out automatically.

- **Paying and adjusting:**
  - **Pay Sales Tax** is its own transaction type (`sales_tax_payment`): Dr Sales Tax Payable,
    Cr bank or card. It appears in registers and the check reports.
  - **Adjustments** (`sales_tax_adjustment`) move the liability against an income account (a
    discount for filing on time) or an expense account (tax owed that wasn't charged).
- **Tie-out:**
  - The Sales Tax Liability report shows, per agency, taxable sales and tax by rate,
    adjustments, payments and the balance due.
  - Anything posted to Sales Tax Payable without an agency (journal entries, QuickBooks history)
    is shown on its own line, so the total always equals the account's balance.
- **Filing periods** are calendar months, quarters or years. The sales tax page shows what the
  last period owes: the balance through its end, less payments and adjustments since.

### Reports

- **One service, one snapshot:** `ReportsService` dispatches every report key to a function over
  a `ReportScope`: the company, its accounts, and one repeatable-read transaction. One URL serves
  every report: `/reports/:slug`.
- **Columns:**
  - The statement builders take a vector of amounts per account, one value per column
    (`report-builder.ts`).
  - Profit and Loss columns: periods (months, fiscal quarters, fiscal years), classes, locations,
    customers or vendors, plus a total. A "Not specified" column holds lines without the
    dimension, so the columns always add up to the total.
  - Balance Sheet columns: dates.
  - Every amount column carries its own drill-down (`columnDrill`: dates and dimension
    filters), so any number opens the transactions behind it.
- **Comparisons and budgets** are derived columns: $ change and % change, or over budget and % of
  budget. Percentages are computed exactly in integers.
- **The cash basis** extends to customer, vendor and "not specified" filters: recognitions carry
  the parties of the document lines they come from.
- **Statement of Cash Flows** (indirect method):
  - Cash is the bank accounts.
  - Net income plus the change in every other balance sheet account explains the change in cash
    exactly: operating (A/R, other current assets, A/P, cards, other current liabilities),
    investing (fixed and other assets), financing (long-term liabilities and equity).
- **Detail reports:**
  - P&L Detail, Balance Sheet Detail and Transaction Detail by Account are the general ledger
    with a different set of accounts and with or without beginning balances.
  - The Journal, Deposit Detail, Check Detail, Missing Checks, Collections and 1099 Contractor
    Detail are tabular reports; their rows carry the transaction for drill-down.
  - The 1099 summary is now computed from the same per-payment entries as the detail.
  - Row limits (20,000) are stated on the report.

### Custom report builder

- **Source:** the lines of posted transactions.
- **Choices:**
  - the columns (from a fixed list);
  - filters (accounts, account types, transaction types, customer, vendor, class, location,
    amount range, text);
  - grouping, subtotals and sorting.
- **Safety:** every column, sort and filter maps to a fixed SQL expression. Nothing from the
  request becomes SQL text, and search text is a bound, escaped `ILIKE` pattern.

### Exports

- Every report becomes one table model (`reportToTable`, shared), then:
  - **CSV:** UTF-8 with a byte-order mark. Text that a spreadsheet would run as a formula
    (`= + - @`) gets a leading apostrophe; numbers stay numbers.
  - **Excel:** a minimal Office Open XML workbook written with `fflate`. Amounts are real
    numbers formatted `#,##0.00`, percentages `0.00"%"`, with a frozen header row.
  - **PDF:** `pdf-lib` with the standard Helvetica fonts. It is paginated, the header repeats
    on every page, amounts are right-aligned and totals ruled, and it switches to landscape for
    wide reports. Text outside Windows-1252 is mapped to the nearest ASCII.
- `pdf-lib` is the only new dependency. It will also fill the IRS forms in Phase 9.

### Memorized and scheduled reports

- **Memorizing:**
  - A memorized report keeps a report key and validated settings: the date preset, the filters,
    the columns and, for custom reports, the definition.
  - Dates stay relative ("last month"), so a scheduled report always covers the right period.
  - It is private to its creator or shared with everyone who can see reports. Only the creator
    changes it; owners and admins may delete shared ones.
- **Schedules:**
  - Daily, weekly (a weekday) or monthly (a day, or the last day), at an hour in an IANA time
    zone, as PDF, Excel or CSV, to at most 20 addresses.
  - The next run is computed in the time zone, across daylight-saving changes.
- **The scheduler:**
  - It runs in the API process every minute (`REPORT_SCHEDULER`).
  - It claims due schedules across companies through a `security definer` function that takes
    a 10-minute lease and returns only the report, company and creator.
  - Each report then runs inside `withTenant` as its creator, and only while they still have
    `reports.view` in that company; otherwise the schedule stops.
  - Sends and failures are recorded on the report and in the audit log. A failure moves on to
    the next run and never retries in a loop.
  - Mail now supports attachments.

### Budgets

- **Structure:**
  - Twelve months from a first month, for income and expense accounts.
  - Optionally per class, location or customer (the budget's dimension).
  - Amounts are entered as positive numbers and turned into ledger signs by the reports.
- **Saving** replaces every amount at once. The editor can fill a budget from the previous
  twelve months' actuals, adjusted by a percentage.
- **Reports:** Budget Overview (by month) and Budget vs. Actuals (total, or by month). A
  dimension filter picks that dimension's budget and actuals.

### Permissions

- `sales_tax.manage` sets up rates and agencies, pays and adjusts. It belongs to owners, admins,
  accountants and standard users.
- `budgets.manage` edits budgets. It belongs to owners, admins and accountants.
- `reports.view` runs, exports and memorizes reports, and reads budgets, agencies and the
  sales tax summary.
- Sellers (`sales.view`) can read the rates they charge.

## Consequences

- Sales tax is exact per agency and always ties to Sales Tax Payable. Reports stay correct when
  rates change because each document keeps what it charged.
- Every new report is a function over the same scope and table model. Exports, memorizing and
  schedules work for it without further code.
- The scheduler lives inside the API until background jobs arrive (Phase 12). Several API
  instances are safe: the lease means each schedule is sent once.
- Scheduled reports send company figures to any address the person enters. This is audited and
  limited to 20 recipients; whether to restrict it further is an open question.
- Not done yet:
  - Sales tax on a cash basis (reporting tax when it is collected).
  - Tax by ship-to address, and an external calculator.
  - Inventory reports (Phase 10) and payroll reports (Phase 8).
