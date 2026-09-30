# ADR 0017: Payroll tax forms and prior payroll (Phase 9, part 1)

- Status: Accepted
- Date: 2026-09-30

## Context

Phase 9 produces the payroll tax forms: Forms 941 (with Schedule B), 944, 940 (with Schedule A),
W-2 and W-3, the SSA's EFW2 file, the 1099s with Form 1096 and the IRS's IRIS file, and each
supported state's quarterly reports. Transmission is Phase 11.

The IRS, SSA and state sites are blocked from this environment. Of the documents Phase 9 needs,
the owner has supplied the **2026 General Instructions for Forms W-2 and W-3**. Still missing:
the 2026 Forms 941/944/940 and their instructions, the fillable form PDFs, SSA Publication 42-007
(EFW2), IRS Publication 5717 and the IRIS schemas, the 1099 forms and instructions, and the state
return forms.

The owner decided (2026-09-30, "go with your recommendations"):

1. **PDFs:** fill in the IRS's own fillable PDFs once they are supplied, rather than drawing
   look-alike forms. Copy A of the W-2, the W-3 and the 1099s go to the SSA and IRS electronically
   (EFW2, IRIS), not as printouts.
2. **State reports:** printable reports and a wage spreadsheet now; each state's upload format
   later.
3. **Prior payroll:** a way to enter pay from before payroll started here (open question 51).

Part 1 builds everything these documents support: prior payroll, the figures behind every form,
Forms W-2 and W-3 box by box, and filing records. Filling in the official forms and building the
upload files follow as their documents arrive.

## Decision

### Pay records

- Every form is built from **pay records**: each posted paycheck, and each prior payroll entry,
  dated by its pay date. Wages belong to the year and quarter they were paid (W-2 instructions,
  "Calendar year basis"). Voided paychecks are left out.
- The builders in `payroll/forms/` are **pure** functions over pay records, tested with the W-2
  instructions' own examples. `TaxFormsService` loads the records and adds filing state.
- **Tax lines record wages before any wage base** (`paycheck_lines.subject_wages`, migration
  0016). The engine passes it for social security, FUTA, state unemployment, CA ETT and SDI.
  State reports then show total, excess and taxable wages, and the FUTA summary shows wages over
  the base. Lines from before the migration fall back to taxable wages.

### Prior payroll

- `prior_payroll_entries` and `prior_payroll_lines` (migration 0016) hold totals per employee and
  pay date: items paid (earnings, deductions, contributions) and taxes, each with its taxable
  wages and wages before the base.
- **The pay date must be before the first payroll here** (`payroll_start_date`). Each tax names
  its state where it has one (`PAYROLL_TAX_STATES`), and who pays it comes from the code
  (`PAYROLL_TAX_PAYERS`).
- It **counts toward year-to-date wage bases and limits** (pay runs' `ytd()` and item limits read
  it) and on every form.
- It is **not posted to the books**, because the old system's pay is already in them. It adds no
  liabilities, because the old system's deposits paid them.
- It **can change until a filed form covers its period**, then it is locked.
- **Deposits made before payroll started here** (`prior_tax_deposits`, migration 0017, open
  question 59): federal Form 941 and 940 deposits the old service made for quarters that began
  before the first payroll here. They may be paid after the switch, since the old service pays its
  last period's taxes later.
  - They add to the Form 941 and 940 summaries' deposits (shown separately as
    `priorDeposits`).
  - Like prior payroll, they aren't posted to the books, touch no liabilities, and lock once
    their Form 941 (quarter) or Form 940 (year) is filed.

### Form W-2 and W-3 (`forms/w2.ts`)

Box by box, per the 2026 instructions:

| Box   | From                                                                                                                                                                        |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1, 2  | Federal income tax: taxable wages and tax                                                                                                                                   |
| 3, 7  | Social security taxable wages, split per paycheck: that paycheck's reported tips (cash and card tips) go in box 7, the rest in box 3                                        |
| 4     | Employee social security tax                                                                                                                                                |
| 5, 6  | Medicare taxable wages; employee Medicare plus Additional Medicare tax                                                                                                      |
| 10    | Dependent care FSA amounts                                                                                                                                                  |
| 12    | D 401(k), E 403(b), AA Roth 401(k), BB Roth 403(b), W HSA (employee through the cafeteria plan and every company HSA contribution), TP reported tips, TT qualified overtime |
| 13    | Retirement plan: any 401(k), 403(b), Roth or match contribution in the year                                                                                                 |
| 14a   | CA SDI, NY PFL, NY DBL (labeled)                                                                                                                                            |
| 14b   | The employee's Treasury tipped occupation code(s) when TP is reported                                                                                                       |
| 15–17 | Each state with state income tax: the registration's withholding account number, wages and tax                                                                              |
| 18–20 | NYC and Yonkers                                                                                                                                                             |

- **Code TT** is the FLSA overtime premium: for an overtime line at a multiple M of the regular
  rate, amount × min(M − 1, 0.5) ÷ M. Double time and exempt employees' overtime aren't counted.
- **Each W-2 lists problems**, from the instructions' reconciliation rules (p.26) and what every
  W-2 needs: a missing SSN or address, boxes 3 + 7 over the wage base, a box 5 less than boxes
  3 + 7, box 4 or 6 without wages, TP without an occupation code, and a state without its account
  number. Notes cover more than four box 12 items or more than two states or localities.
- **The W-3** totals the W-2s. Box 12a is codes D, E, AA and BB. Kind of payer comes from the
  federal form setting; kind of employer is "501c non-govt." for Form 990 filers, else "None
  apply". Box 15 is the state, or "X" when there is more than one.
- **Reconciliation:** boxes 2, 3, 5 and 7 by quarter, compared with each filed Form 941's
  snapshot.
- The W-2 due date (February 1, 2027) and the 2026 elective deferral limit are in
  `federal.json` with citations.

### Quarterly and annual summaries (`forms/quarterly.ts`)

- **Federal quarter** (what Form 941 and Schedule B are filled from):
  - employees paid; wages; income tax; social security wages and tips; Medicare wages;
    Additional Medicare wages;
  - each tax;
  - tax at the full rates from `federal.json`, and the fractions-of-cents difference;
  - liability by month and by pay date;
  - Form 941 deposits recorded and the balance due.
- **FUTA year:** wages before and after the base, tax, taxable wages by state (Schedule A), the
  liability by quarter, and deposits.
- **State quarter:**
  - withholding (state, NYC, Yonkers, CA SDI, NY PFL and DBL);
  - each employee's total, excess and taxable unemployment wages and tax, and RSF or ETT;
  - the return's form name and due date where tax-data has them (CA DE 9, FL RT-6).

### Filings

- `tax_filings` (migration 0016) records that a form was filed: the form, period, date, method
  and confirmation number, and a **snapshot** of its figures (never SSNs).
- One filed record per form and period. A filing is voided, never deleted.
- A form whose figures differ from its snapshot lists each difference ("changed since filed"),
  so a voided paycheck shows up as needing a correction. Paychecks are not blocked.
- The W-2s can't be marked filed while any W-2 or the W-3 has problems.

### SSNs

- Forms show SSNs masked.
- The state wage detail CSV has full SSNs, because states need them. It needs
  `payroll.sensitive.reveal`, is a POST (CSRF-protected, not cached), is returned and never
  stored, and writes an audit row without SSNs.

### Screens

Payroll › Tax forms, with three pages:

- **Quarterly:** the federal quarter and each state's quarter;
- **Year end:** W-2s, the W-3, reconciliation and FUTA;
- **Prior payroll.**

The W-2 worksheet exports to PDF, Excel and CSV through the report renderer.

## Consequences

- A company can see and check every figure its quarterly and year-end returns need, file them
  from these figures, and record the filing. A company that starts mid-year enters its earlier
  pay once, and wage bases and forms include it.
- **Waiting on documents:**
  - Forms 941, 944 and 940 filled line by line (their 2026 instructions);
  - the official W-2/W-3 PDFs;
  - the EFW2 file (Pub. 42-007);
  - 1099-NEC/MISC, 1096 and IRIS (1099 instructions, Pub. 5717, IRIS schemas);
  - state return layouts.
- **Not done yet:**
  - corrections (W-2c, 941-X) beyond listing what changed: decided to wait for their
    instructions (question 60);
  - box 12 DD (health coverage cost), whose reporting rules the instructions leave to IRS.gov;
  - local tax names in box 20 beyond "NYC" and "YONKERS".
