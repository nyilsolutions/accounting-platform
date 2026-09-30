# Phase 8: Payroll core (in progress)

Phase 8 is being built in two parts:

1. **Setup and employees:** everything that needs no tax figures. This part is done and
   described below.
2. **The tax engine and pay runs:** waiting on `tax-data/2026/federal.json`. The master plan
   requires that file to be built from IRS sources and checked by you before any tax code is
   written. www.irs.gov and www.ssa.gov are still blocked from this environment (open question
   44), so the file does not exist yet.

Supported states: California, Florida, Illinois, New York and Texas (`docs/states.md`).

## Delivered (part 1)

- **Payroll setup** (Payroll › Setup):
  - **Turn payroll on.** This picks the chart's Payroll Expenses › Wages, › Payroll Taxes and
    Payroll Liabilities accounts, and creates the standard earnings items.
  - **Settings:**
    - the federal return (941 or 944) and the deposit schedule;
    - the first payroll date here;
    - the default accounts, and the bank account paychecks come from;
    - your bank's details for direct deposit files.
  - **Pay schedules:** weekly, every other week, twice a month or monthly. Each shows its next
    periods and pay dates, and weekend pay dates move to Friday.
  - **States:** withholding and unemployment account numbers, and your unemployment rate for
    each year, from the state's notice.
  - **Workers' compensation** classes, with rates per $100 of wages.
  - **PTO policies:** vacation, sick or personal, accrued per hour worked, per paycheck or once
    a year, with a maximum balance and a carryover limit.
  - **Payroll items:**
    - earnings, pre-tax deductions, after-tax deductions (including garnishments by type) and
      company contributions;
    - optional accounts, and who each deduction is paid to.

    How each kind is taxed comes from the year's tax tables, with the engine.
- **Employees** (Payroll › Employees):
  - **Details:**
    - personal details, with the **SSN encrypted** (shown masked; revealing it is logged);
    - home address and work location;
    - hire date and last day;
    - pay type and rate, usual hours, schedule, pay method, overtime exemption, workers' comp
      class, class and location.
  - **Form W-4 history**, 2020-and-later or pre-2020, each effective from a date.
  - **State certificates:** IL-W-4, DE 4, or IT-2104 with New York City and Yonkers residence.
  - **Direct deposit:**
    - up to three accounts, as a fixed amount, a percentage, or the rest;
    - routing numbers checked;
    - **account numbers encrypted**;
    - an optional prenote for each account.
  - **Recurring deductions and contributions** (for example a 401(k) percentage, or a
    garnishment with its case number and total owed), and **PTO balances**.
  - **"To complete":** each employee lists what is still needed before their first paycheck.
  - Employees are **terminated, never deleted**.
- **Direct deposit files** (Payroll › Direct deposit):
  - A **NACHA prenote file** for accounts waiting to be verified, generated through the
    `PaymentRail` interface for you to upload to your bank.
  - Files are never stored. The history keeps the date, entry count, total and SHA-256 of each
    file.
- **Contractors:** the vendor form records when **Form W-9** came in, and whether **backup
  withholding** applies.
- **Permissions:** `payroll.sensitive.reveal` (owners, admins, accountants, payroll admins)
  reveals SSNs. Payroll admins work without ledger access.
- **Seed:** Sample Landscaping Co. has:
  - payroll turned on, with a schedule every other Friday;
  - its Texas unemployment registration and rate, a landscaping workers' comp class, and a
    vacation policy;
  - 401(k), health and match items;
  - three employees:
    - **Maria Lopez:** complete, with direct deposit waiting for its prenote;
    - **David Chen:** salaried, SSN not provided yet;
    - **Kim Nguyen:** a new hire with job details only.

## Demo script

1. Run `pnpm db:migrate && pnpm db:seed && pnpm dev` and sign in as `demo@example.com`.
2. Press `g p` for **Payroll**.
   - The employee list shows pay, schedule and state, and what each employee still needs.
3. Open **Maria Lopez**:
   - her W-4, direct deposit (masked account and prenote status), 401(k) and health
     deductions, and vacation balance;
   - **Show SSN**, then check the audit log for `employee.ssn_revealed`.
4. Open **Kim Nguyen**:
   - **Add Form W-4** (married filing jointly, $4,000 of dependents);
   - enter an SSN;
   - watch "To complete" shrink.
5. On **Setup**:
   - change the deposit schedule;
   - add a workers' comp class;
   - **Set rate** for next year's Texas unemployment rate;
   - add a garnishment item.
6. On **Direct deposit**, create the **prenote file**. It downloads as `prenote-<date>.ach`.
   Maria's account then shows "Prenote sent".
7. In Expenses › Vendors, edit a 1099 vendor and record the W-9 date and backup withholding.

Screenshots: `docs/screenshots/80-payroll-setup.png`, `81-employee.png`, `82-direct-deposit.png`.

## Tests

| Suite                   | Count | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`       | 146   | +21: SSN rules, the ABA check digit, pay periods for every frequency (anchors in the past and future, short months, weekend pay dates), schedule, rate, PTO and item rules, employee rules, W-4 versions, state certificate forms, direct deposit splits, recurring items                                                                                                                                                                                                                                                          |
| `packages/db`           | 73    | +9: payroll tables isolated by company, composite keys across companies, semimonthly anchors, W-4 fields per version, SSN stored with its last four only, one "rest of pay" account, item constraints, no deletes of employees or ACH records, row-level security on all 14 tables                                                                                                                                                                                                                                                 |
| `apps/api`              | 298   | +26. Setup: before and after payroll is on, default accounts and items, account types, lookups, permissions. Schedules, states and rates, workers' comp, PTO, items. Employees: SSN encrypted, masked everywhere and absent from the audit log; reveal permission and audit; a copied ciphertext fails to decrypt; validation. W-4 history, state certificates, direct deposit encryption and reordering, prenote file (layout, statuses, history). Recurring items, PTO, termination, tenant isolation, W-9. NACHA record layouts |
| `apps/web` (Playwright) | 10    | +1: set up payroll, settings (checking that the selects keep their saved accounts), schedule, New York with a rate, a 401(k) item, an employee with W-4, IT-2104 and direct deposit, the prenote file. The Phase 0 test now expects payroll setup instead of the placeholder                                                                                                                                                                                                                                                       |

## Next (part 2, after you sign off `federal.json`)

- `tax-data/2026/federal.json`, with every figure cited, for you to check. Then golden tests
  from the Pub 15-T worked examples.
- The `TaxEngine`:
  - the federal percentage method, including pre-2020 Forms W-4;
  - Social Security, Medicare and Additional Medicare;
  - FUTA with credit reduction;
  - supplemental wages;
  - qualified tips and overtime.

  Also the state calculators for the five states, from their own tables.

- Pay runs:
  - regular, off-cycle, bonus and final paychecks;
  - the hours grid;
  - preview, approve and post through `PostingService`;
  - paychecks and pay stubs;
  - the payroll deposit file.
- Liabilities by agency and due date, with the $100,000 next-day rule and `EFTPSProvider`.
- Payroll reports.
