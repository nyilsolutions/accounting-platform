# ADR 0016: Payroll tax engine, pay runs, liabilities and reports (Phase 8, part 2)

- Status: Accepted
- Date: 2026-09-30

## Context

Part 1 (ADR 0015) built payroll setup and employees without any tax figure. The master plan
requires `tax-data/<year>/federal.json` to be built from IRS sources and checked by the product
owner before any tax code is written. The IRS and state sites are blocked from this environment, so
the owner supplied the documents instead:

- **Federal:** Pub. 15-T, Pub. 15, Pub. 15-B and the SSA wage base.
- **States:** the IL, NY, CA, FL and TX publications, statutes, rules and agency pages listed in each
  state file's `sources`.

The owner approved the figures for building on 2026-09-30 (`ownerApproval` in each file). A CPA or
payroll specialist's review (`reviewedBy`) is still required before real paychecks.

## Decision

### The tax data is the only source of tax rules

- **Every tax figure comes from the tax files.** Rates, wage bases, thresholds, tables, deposit
  rules and the taxability of each kind of pay live in `tax-data/2026/federal.json` and
  `states/<state>.json`. Each figure cites its source, page and wording (CLAUDE.md rule 7).
  Nothing in `apps/api/src/payroll` is a tax figure.
- **Which pay is taxable, and for which tax, is data:**
  - Federal: `taxabilityByItemKind` (`regularWageKinds`, plus each kind for income tax, FICA and
    FUTA).
  - Each state: `taxableWages` has a rule for income tax, unemployment, SDI and Paid Family Leave.
    A rule is either `basis: federal_fit`, where the state follows federal withholding wages (New
    York per TSB-M-84(7)I, Illinois per Pub. 130), or a list of kinds.
  - A kind's treatment can change on a date. Illinois stops counting a company 401(k) match as
    unemployment wages after June 30, 2026, and the engine picks the treatment by pay date.
- **Anything not sourced is refused with its reason, never guessed.** Examples:
  - California income tax, waiting on DE 44.
  - Florida employee 401(k) deferrals for unemployment.

  Refusals are collected, so a paycheck lists every problem at once.

- **The published examples are the tests.**
  - Golden tests reproduce each publication's worked examples: Pub. 15/15-T, IL-700-T, and all 27
    NYS, NYC and Yonkers examples.
  - The federal examples use wage bracket tables. Those tables are the percentage method applied
    to the middle of each row and rounded to the dollar, so the tests compute that and compare
    exactly.
  - Three New York booklet examples are off by a cent. Each records its `discrepancy` and
    `expectedFromTables`.

### The tax engine

- `payroll/tax/tax-engine.ts` is pure and works in exact fractions (`tax/rational.ts`). It rounds
  once, or at each step where a publication does (the New York method rounds each step).
- **Federal:**
  - income tax by the Pub. 15-T Worksheet 1A percentage method, for Forms W-4 from 2020 on and from
    2019 or earlier;
  - nonresident alien additions;
  - no Form W-4 on file: single with no adjustments, with a notice;
  - supplemental wages paid separately at 22%, and 37% above $1 million for the year;
  - social security to the wage base, Medicare, Additional Medicare over $200,000;
  - FUTA at the 0.6% net rate. Credit reductions are applied on Form 940, not per paycheck.
- **States:**
  - Illinois: the automated method; no IL-W-4 means no allowances; bonuses at the flat rate.
  - New York State: Method II, and Method III for top incomes.
  - New York City and Yonkers resident withholding. The Yonkers nonresident Method VIII is
    implemented and tested but not wired in, because nothing yet records who works in Yonkers.
  - New York Paid Family Leave, up to its annual cap.
  - Unemployment for every state at the employer's own rate for the year, plus the New York
    Re-employment Service Fund, California ETT and California SDI.
- **Year to date comes from posted paychecks.** Wage bases and caps use the taxable wages recorded
  on earlier posted paychecks' tax lines. Pay from before `payroll_start_date` isn't known yet
  (open question 51).

### Pay runs and paychecks

- **Tables** (migration 0011): `pay_runs`, `paychecks` and `paycheck_lines`.
- **Kinds of run:**
  - A **regular** run pays a schedule's next unpaid period. It starts hourly employees at their
    usual hours and salaried employees at the annual salary divided by the pay periods in the year.
  - An **off-cycle**, **bonus** or **final** run pays the employees chosen. Bonus runs use the
    supplemental rates.
- **What a paycheck stores:**
  - its **input**: the earnings entered, plus deduction and contribution amounts that replace a
    recurring item for this paycheck (`"0"` skips it);
  - its **lines**, recalculated from that input and the current facts on every change and at
    approval.
- **Recurring items:**
  - Percentages apply to pay for work, not to reimbursements.
  - Annual limits and a garnishment's total owed cap each item.
  - Off-cycle and bonus checks take only percentage items.
- **Lifecycle:** draft, then approve (frozen; reopen to change), then post.
  - Approval needs every paycheck free of problems and a bank account in the settings.
  - Posting creates one `paycheck` transaction per employee through `PostingService`:
    - earnings, company taxes and company contributions to expense (with the employee's class and
      location);
    - withholdings, deductions, company taxes and contributions to the payroll liability account
      (the item's own accounts first);
    - net pay credited to the bank account.
  - A posted paycheck is voided, never changed or deleted. Database triggers freeze its lines and
    amounts, and keep posted runs.
- **Direct deposit:**
  - At posting, net pay is split across the employee's accounts: fixed amounts, then percentages,
    then the remainder. The split is stored as masked accounts.
  - The payroll NACHA file is built from that split through `PaymentRail`. It is created once per
    run, returned to the caller and never stored (ADR 0015).

### Liabilities and payments

- **What is owed** comes from posted paychecks, grouped by agency and deposit period
  (`payroll/liabilities.ts`, pure):
  - **Form 941 taxes:**
    - monthly depositors: the 15th of the following month;
    - semiweekly depositors: Wednesday–Friday pay dates are due the following Wednesday,
      Saturday–Tuesday the following Friday;
    - the $100,000 next-day rule, after which the company is a semiweekly depositor for the rest of
      the year and the next.
  - **FUTA:** quarterly. A quarter at $500 or less carries forward to the quarter that takes the
    undeposited total over $500, and is due by January 31 at the latest.
  - **State taxes:** by quarter, with due dates only where the state file has them. Otherwise a
    note says the schedule isn't sourced.
    - Unemployment: the quarterly return's date from `quarterlyReturns` (California DE 9,
      Florida RT-6).
    - Withholding with a `withholdingDeposits` schedule (Illinois, Pub. 131): monthly (the 15th)
      or semiweekly (Wednesday/Friday) as the state assigned it. The schedule is stored on the
      state registration (migration 0014); unset means the schedule for new taxpayers. More than
      $12,000 withheld in a quarter switches to semiweekly from the next quarter through the next
      year. A semiweekly period never spans two quarters, because each quarter is paid
      separately.
  - **Deductions and contributions:** owed to the payee on the pay date.
  - Weekend due dates move to Monday. Federal holidays wait on open question 46.
- **The lookback period** total from `federal.json` suggests the deposit schedule. The suggestion
  is flagged incomplete when payroll here doesn't cover the whole lookback period.
- **Payments** are `payroll_liability_payment` transactions (liability debited, bank credited),
  recorded against the agency and period (migration 0013).
  - A payment can't be more than the balance, and it is voided, never deleted.
  - Federal payments go through `EftpsProvider`. Today's `ManualEftpsProvider` returns what to
    enter in EFTPS, and the EFT acknowledgement number is kept as the reference. A payroll partner
    replaces it in Phase 11.
  - Tests check that the ledger's Payroll Liabilities balance equals the sum of the liabilities.

### Reports

- **The reports:**
  - Payroll Summary: by employee, with net pay and total cost;
  - Paycheck History: voided paychecks shown at zero;
  - Payroll Tax and Wage Summary: taxable wages counted once, employee and company halves side by
    side.
- **Where they live:** they use the reports hub's `ReportDto`, so they render and export (PDF,
  Excel, CSV) the same way. They are served under `payroll/reports` with `payroll.view`, not in the
  hub under `reports.view`, because they show individual pay and the reports-only role must not
  see it. For the same reason they are not memorized or scheduled.

## Consequences

- A company in Texas, Florida or Illinois can run, post and pay payroll today, including 401(k)
  and cafeteria plans where the state's treatment is sourced. A New York company can too, for pay
  whose Paid Family Leave and unemployment treatment is sourced.
- Payroll is blocked in these cases, and the paycheck says why:
  - any California paycheck, until DE 44;
  - Florida paychecks with an employee 401(k);
  - anything else whose treatment isn't sourced (`docs/open-questions.md`, item 44).
- A new tax year is a new folder of tax files and a professional review. No code changes unless a
  method changes.
- **Not done yet:**
  - prior-payroll year to date (open question 51);
  - garnishment limits under the Consumer Credit Protection Act (52);
  - multi-state work and the Yonkers nonresident tax (53);
  - printing paper paychecks with check numbers (54);
  - deposit schedules for the other states (44), and state holidays;
  - Phase 9's quarterly and annual forms (941, 940, W-2, state returns).
