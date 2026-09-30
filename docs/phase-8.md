# Phase 8: Payroll core

Phase 8 was built in two parts:

1. **Setup and employees** (ADR 0015): everything that needs no tax figures.
2. **The tax engine, pay runs, liabilities and reports** (ADR 0016): built on
   `tax-data/2026/federal.json` and the five state files. The product owner supplied the source
   documents (the IRS, SSA and state sites are blocked here) and approved the figures for building
   on 2026-09-30. A CPA or payroll specialist must review them (`reviewedBy`) before real
   paychecks.

Supported states: California, Florida, Illinois, New York and Texas (`docs/states.md`, which shows
what each state calculates today).

## Delivered

### Part 1: setup and employees

- **Payroll setup** (Payroll › Setup):
  - Turning payroll on picks the chart's Wages, Payroll Taxes and Payroll Liabilities accounts and
    creates the standard earnings items.
  - **Settings:** the federal return and deposit schedule, the first payroll date, default
    accounts, the bank account paychecks come from, and your bank's details for direct deposit.
  - **Pay schedules:** weekly, every other week, twice a month or monthly.
  - **States:** account numbers, and your unemployment rate for each year.
  - **Workers' compensation** classes, **PTO policies**, and **payroll items**.
- **Employees** (Payroll › Employees):
  - personal and job details, with the **SSN encrypted** (shown masked; reveals are logged);
  - **Form W-4** and **state certificate** history (IL-W-4, DE 4, IT-2104 with New York City and
    Yonkers);
  - **direct deposit** to up to three accounts, with **account numbers encrypted** and prenotes;
  - recurring deductions and contributions, and PTO balances;
  - a "to complete" list for each employee.
- **Prenote files** (Payroll › Direct deposit) through `PaymentRail`. Files are never stored.
- **Contractors:** the Form W-9 date and backup withholding on the vendor.

### Part 2: the tax engine

- **Tax data:** every rate, wage base, table, threshold, deposit rule, and which pay counts as
  wages for each tax, with its source, page and wording. It's in `tax-data/2026/federal.json` and
  `states/{il,ny,ca,fl,tx}.json`.
- **Federal:**
  - income tax (Pub. 15-T percentage method, 2020-and-later and earlier Forms W-4);
  - nonresident aliens;
  - no W-4 on file (single, with a notice);
  - bonuses at 22%, and 37% above $1 million;
  - social security, Medicare and Additional Medicare;
  - FUTA.
- **States:**
  - Illinois withholding;
  - New York State, New York City and Yonkers withholding;
  - New York Paid Family Leave;
  - unemployment in every state at your rate;
  - the New York Re-employment Service Fund;
  - California ETT and SDI.
- **Refused, not guessed:** anything the tax files don't source (California income tax until DE 44,
  a Florida employee 401(k), Roth deferrals) is refused, with the reason shown on the paycheck.
- **Golden tests:** every worked example in the supplied publications is reproduced.

### Part 2: pay runs (Payroll › Pay runs)

- **Starting a run:**
  - A **regular** run pays a schedule's next period.
  - **Off-cycle**, **bonus** and **final** runs pay the employees you choose.
- **Each paycheck:**
  - It is calculated from the W-4 and state certificate in effect on the pay date, year-to-date
    wages and your unemployment rate.
  - Recurring deductions apply: percentages of pay, capped at annual limits and a garnishment's
    total owed.
  - **Edit** a paycheck: earnings by hours (overtime at its multiple) or amount, and replace or
    skip (enter 0) a recurring deduction on this paycheck.
  - Problems are listed on the paycheck, and a run can't be approved until they're fixed.
- **Approve** freezes the run; **reopen** to change it.
- **Post** records one paycheck per employee in the books:
  - wages and company taxes to expense;
  - withholdings and deductions to Payroll Liabilities;
  - net pay out of the bank.

  A posted paycheck can be **voided**, never changed.

- **Pay stubs:** earnings, taxes and deductions with year to date, where net pay was deposited, and
  what the company paid. You can print them.
- **Direct deposit file:** the NACHA file for a posted run, split across each employee's accounts.
  It is created once per run and never stored.

### Part 2: taxes and liabilities (Payroll › Taxes & liabilities)

- **Your federal deposit schedule**, and what the lookback period suggests.
- **What you owe**, by agency and deposit period, with due dates:
  - Form 941 taxes: monthly or semiweekly, with the $100,000 next-day rule;
  - FUTA: quarterly, carried forward while at $500 or less;
  - state taxes: by quarter;
  - deductions: owed to their payee.
- **Pay:**
  - For federal taxes by EFTPS, you get the details to enter in EFTPS and record its EFT
    acknowledgement number. A payroll partner can take this over later (`EftpsProvider`).
  - Payments post to the books and can be voided.

### Part 2: payroll reports (Payroll › Reports)

- **Payroll Summary** by employee, **Paycheck History**, and the **Payroll Tax and Wage Summary**.
- All three export to PDF, Excel or CSV.
- Only people with payroll access can see them.

### Demo data

Sample Landscaping Co. has payroll set up with three employees, a posted pay run for the first
September period (Maria Lopez and David Chen) and a draft run for the next period (with Kim Nguyen,
who has no W-4 yet).

## Demo script

1. Run `pnpm db:migrate && pnpm db:seed && pnpm dev` and sign in as `demo@example.com`.
2. Press `g p` for **Payroll**, then open **Pay runs**.
3. Open the **posted** September run:
   - the totals, each paycheck, and the taxes;
   - open **Maria Lopez** for her pay stub. Her $85 cafeteria plan deduction lowers her social
     security and Medicare, and her 4% 401(k) lowers her federal withholding.
4. Open the **draft** run:
   - Kim has a notice that she has no Form W-4;
   - **Edit** Kim's paycheck and add 3 hours of **Overtime** (at 1.5 times her rate); the taxes
     recalculate;
   - **Approve**, then **Post paychecks**;
   - create the **direct deposit file**, which downloads as `payroll-<date>.ach`.
5. **Start pay run → Bonus** for Maria, enter a $500 **Bonus**: federal tax is 22%.
6. **Taxes & liabilities:**
   - see the Form 941 taxes due on the 15th, FUTA carried forward, and the Texas unemployment
     balance;
   - **Pay** the Form 941 taxes by EFTPS and follow the instructions.
7. **Reports:** Payroll Summary for September, then export it to Excel.
8. Void a paycheck from its stub, and watch the run's totals and the liabilities drop.

Screenshots:

- Part 1: `docs/screenshots/80-payroll-setup.png`, `81-employee.png`, `82-direct-deposit.png`.
- Part 2: `83-pay-run.png`, `84-pay-stub.png`, `85-liabilities.png`, `86-payroll-reports.png`.

## Tests

| Suite                   | Count | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`       | 146   | Part 1: SSN rules, the ABA check digit, pay periods, certificate and direct deposit schemas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/db`           | 80    | Part 2 (+7): pay runs, paychecks, lines and liability payments isolated by company; one regular run per period; tax lines name their tax; posted paychecks frozen (lines, amounts, no delete, void stays void); posted runs kept; liability payment agencies checked, never deleted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `apps/api`              | 396   | +98 in part 2. **Golden tests:** the Pub. 15/15-T examples, IL-700-T, and all 27 NYS/NYC/Yonkers examples. **Engine:** W-4 steps, wage bases, Additional Medicare, supplemental 22%/37%, no W-4, and each state's pay rules with citations (Illinois's July 1 match change, New York PFL cap). **Paycheck calculation:** rates and salary, overtime, percentages, limits, overrides, all problems at once. **Liabilities:** monthly and semiweekly due dates, the $100,000 rule, FUTA carry-forward, state and payee periods, payments. **Pay runs end to end:** problems block approval, override, approve/reopen/post, balanced postings, frozen records, deposit file (account never logged), garnishment cap, bonus run, voids. **Liability payments:** EFTPS instructions, overpayment refused, Payroll Liabilities equals what's owed. **Reports and exports.** |
| `apps/web` (Playwright) | 11    | +1: set up, start a run, fix a refused paycheck by skipping a 401(k), approve, post, download the deposit file, check the pay stub and year to date, pay the IRS by EFTPS, run the Payroll Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Not in this phase

- Pay from before payroll started here (open question 51).
- Garnishment limits (52).
- Multi-state work and the Yonkers nonresident tax (53).
- Printing paper paychecks (54).
- State deposit schedules (44).
- **Phase 9:** Forms 941 and 940, W-2 and W-3, state quarterly returns, and 1099s.
