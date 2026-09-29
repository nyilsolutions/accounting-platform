# Phase 7: Reports suite, sales tax, budgets

## Delivered

- **Sales tax** (Sales tax in the menu, permission `sales_tax.manage`):
  - **Agencies**, with their filing frequency and account number.
  - **Rates:**
    - Single rates, whose percentage can change from a date. Documents already dated keep the
      rate they were charged.
    - Combined rates (state + county + city…).
  - **Charging tax:**
    - Invoices, sales receipts, credit memos, refund receipts and estimates have a **Tax**
      column and a rate, which new documents take from the customer's default.
    - The form previews the tax per agency, exactly as it will be charged.
    - An entered amount overrides the calculation (for copying paper invoices).
    - **Exempt customers** (with a reason and certificate number) are charged nothing.
  - **What you owe:** each agency's amount due for the last filing period and to date, with
    **Record payment** and **Adjust** (a discount for filing on time, or tax you didn't charge).
    The payment and adjustment history can be voided.
  - The tax posts to Sales Tax Payable per agency. An estimate's tax carries over to the invoice
    it becomes. A calculator interface is ready for an external service.
- **Reports:**
  - **Profit and Loss:**
    - By **months, quarters or years**, or by **class, location, customer or vendor** (with a
      "Not specified" column and a total).
    - Compared with the **previous period or year** ($ and % change).
    - Filters for class, location (including "not specified"), customer and vendor, on the
      accrual or cash basis.
  - **Balance Sheet** at each month, quarter or year end, or compared with a year earlier.
  - **New reports:**
    - Statement of Cash Flows;
    - Profit and Loss Detail, Balance Sheet Detail, Transaction Detail by Account, Journal;
    - Collections Report;
    - 1099 Contractor Detail;
    - Deposit Detail, Check Detail, Missing Checks (gaps and duplicates);
    - Sales Tax Liability;
    - Budget Overview, Budget vs. Actuals.
  - **Every amount drills down**, column by column, to the transactions behind it.
  - **Export** any report to **PDF, Excel or CSV**.
- **Memorized reports:**
  - **Memorize** saves a report's settings with relative dates ("last month"), private or shared
    with everyone who can see reports.
  - The **Memorized** tab opens them, **emails them on a schedule** (daily, weekly or monthly, at
    an hour in your time zone, as PDF, Excel or CSV), or **sends one now**.
  - A schedule stops if the person who set it up loses access to reports.
- **Custom report builder** (Reports › Custom report):
  - Columns chosen from date, type, number, name, memo, account, account type, class,
    location, due date, debit, credit and amount.
  - Filters: account types, transaction types, customer, vendor, class, amount range and text.
  - Grouping with subtotals (account, name, customer, vendor, class, location, type, month,
    quarter) and sorting.
  - Exports and memorizes like any report.
- **Budgets** (Reports › Budgets):
  - Twelve months per income and expense account, optionally per class, location or customer.
  - The grid can **fill from last year's actuals**, adjust them by a percentage, and copy a
    month across.
  - Budget vs. Actuals shows the total or month by month.
- **Seed:** Sample Landscaping Co. (Austin, TX) has:
  - the Texas Comptroller, with state 6.25%, city 1% and transit 1% combined as **Austin
    8.25%**;
  - a taxable mulch item, and Oakwood Dental charged tax on an April invoice;
  - a budget for the year;
  - three memorized reports: a shared P&L by month, a weekly A/R aging emailed on Mondays, and a
    custom "Expenses over $500".

## Configuration

| Variable           | Default | Notes                                                                                                                                  |
| ------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `REPORT_SCHEDULER` | `on`    | Checks every minute for scheduled reports to email. Set `off` on API instances that shouldn't send (a lease keeps sends unique anyway) |

Scheduled reports go through the configured mail transport (`MAIL_TRANSPORT`) with the report
attached. The `file` transport writes attachments into the outbox JSON (base64).

## Demo script

1. Run `pnpm db:migrate && pnpm db:seed && pnpm dev` and sign in as `demo@example.com`.
2. Open **Sales tax**:
   - The Texas Comptroller and the Austin 8.25% rate (6.25% + 1% + 1%).
   - What the current quarter owes.
3. Open Oakwood Dental's April invoice (Sales › All sales): the mulch is taxed, the labor isn't.
   Back on **Sales tax**, choose **Record payment** for the quarter.
4. Press `g r`:
   - **Profit and Loss** with **Display columns by: Months**, then **Classes**.
   - **Compare with: Previous year**.
   - Click any amount to see its transactions.
5. **Export ▾ › Excel**, then **PDF**.
6. **Memorize** the report. In the **Memorized** tab, choose **Email on a schedule…** and
   **Send now**. With `MAIL_TRANSPORT=console` the API log shows the email and its attachment.
7. **Budget vs. Actuals** for the FY budget, by month. Open **Budgets**, change a month, **Fill
   from last year's actuals** with +5%, and save.
8. **Custom report**: group by account with subtotals, filter to expenses over 500, run, export.
9. **Statement of Cash Flows**, **Sales Tax Liability** and **Missing Checks**.

Screenshots from the end-to-end run: `docs/screenshots/70-sales-tax-setup.png` to
`77-sales-tax-liability.png`. The report screenshots from earlier phases (12–14, 26, 27, 34)
were refreshed for the new settings bar.

## Tests

| Suite                   | Count | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared`       | 125   | +11: tax rounding per component, exempt customers, override split, rate validation; report slugs and "none" filters; custom report columns only from the list; memorized dates; schedules (time zones, recipients); week and 30-day presets; month arithmetic                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/crypto`       | 13    | Unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/db`           | 64    | +6: tenant isolation of sales tax tables, single/combined rate rules, no deletes of agencies and rates, budget month and uniqueness rules, schedule consistency, cross-company claim with a lease and no table access outside a company                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/api`              | 272   | +46. Sales tax: setup and permissions, per-agency tax on invoices, rate changes by date, exemption, override, credit memos, estimates to invoices, summary per filing period, payments, adjustments, void, tie-out to Sales Tax Payable. Reports: P&L by month/class/customer/quarter, comparisons, balance sheet columns, cash flow ties to cash, detail reports, collections, deposit/check detail, missing checks, 1099 detail, liability; budgets and Budget vs. Actuals; custom reports (and injection attempts); CSV/Excel/PDF exports; memorized reports, sharing, schedules sent by the scheduler, access loss; units for periods, percentages, DST schedules, exports |
| `apps/desktop-agent`    | 12    | Unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `apps/web` (Playwright) | 9     | +1: agency and rates, taxed invoice with preview, payment, P&L by month, Excel export, memorize and schedule, budget and Budget vs. Actuals, custom report, Sales Tax Liability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Known gaps and decisions for later phases

- **Sales tax:**
  - Accrual only: tax is owed when charged. Cash-basis sales tax reporting (owed when collected)
    isn't there yet.
  - Rates are chosen per document; there is no lookup by ship-to address. An external
    calculator (Avalara, TaxJar) plugs into `SalesTaxCalculator`.
  - Sales tax charged in QuickBooks history (Phase 6 imports) is not assigned to agencies. It
    shows as "Not assigned to an agency" on the liability report, and the report still ties.
  - Use tax on purchases is not tracked.
- **Reports:**
  - Inventory valuation and stock status come with inventory (Phase 10); payroll reports come
    with payroll (Phase 8).
  - The Audit Log report is the existing audit log page (linked from Reports).
  - Reconciliation reports stay under Banking.
  - Detail reports and custom reports stop at 20,000 lines and say so.
- **The scheduler** runs inside the API process. A job queue comes in Phase 12. There is no real
  email transport yet (open question 6); scheduled reports go through the development
  transports.
- **Budgets** cover income and expense accounts only (not balance sheet accounts), twelve months
  at a time.
