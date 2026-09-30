# Phase 9: Payroll tax forms (part 1)

Phase 9 makes the quarterly and year-end payroll forms. Part 1 (ADR 0017) is everything the
documents supplied so far support:

- entering pay from before payroll started here;
- the figures behind every form;
- Forms W-2 and W-3 box by box, from the 2026 General Instructions for Forms W-2 and W-3;
- recording filings.

Filling in the official PDFs (941, 944, 940, W-2, W-3, 1099) and building the SSA and IRS upload
files wait on their 2026 documents (`docs/open-questions.md`, item 57). The owner chose the
official fillable PDFs over look-alike forms, printable state reports and a wage spreadsheet for
now, and a prior payroll entry.

## Delivered

### Prior payroll (Payroll › Tax forms › Prior payroll)

- Pay from before your first payroll here, entered per employee and pay date:
  - earnings, deductions and contributions by payroll item;
  - each tax, with the wages it was figured on (and wages before the wage base when higher).
- It counts toward year-to-date wage bases and limits: FUTA stops at $7,000 across old and new
  pay. It is included on every form.
- It isn't posted to the books, because the old system's pay is already there.
- It is locked once a filed form covers its period.

### Quarterly (Payroll › Tax forms › Quarterly)

- **Federal quarterly summary**, everything Form 941 and Schedule B are filled from:
  - employees paid, wages, federal income tax;
  - social security wages and tips, Medicare wages, Additional Medicare wages, each tax;
  - tax at the full rates and the fractions-of-cents difference;
  - liability by month and by pay date;
  - deposits recorded, and the balance due.
- **Each state's quarterly reports:**
  - withholding (state, NYC, Yonkers, CA SDI, NY PFL and DBL);
  - unemployment wages per employee (total, excess, taxable, tax), plus RSF or ETT;
  - the return and due date where tax-data has them (California DE 9, Florida RT-6).
- **Wage detail (CSV)** for the state, with full SSNs. It needs permission to reveal SSNs, is
  never stored, and each export is audited.

### Year end (Payroll › Tax forms › Year end)

- **Forms W-2**, box by box:
  - boxes 1–7 and 10;
  - box 12: D, E, AA, BB, W, TP and TT;
  - the retirement plan box;
  - box 14a: CA SDI, NY PFL, NY DBL;
  - box 14b: tipped occupation codes, now on the employee;
  - states and NYC/Yonkers.

  Each W-2 lists what the SSA would reject (the instructions' reconciliation rules) and anything
  missing (SSN, address, state account number).

- **Form W-3** totals, and a reconciliation of boxes 2, 3, 5 and 7 with each quarter's filed Form 941.
- **The W-2 worksheet** exports to PDF, Excel or CSV, with SSNs masked.
- **Federal unemployment (Form 940):**
  - wages before and after the $7,000 base, and the tax;
  - taxable wages by state (Schedule A);
  - the liability by quarter, and deposits.

### Filings

- **Mark filed** records the date, how it was filed and the confirmation number, with a copy of
  the figures.
- If a paycheck in a filed period is later voided, the form lists what changed since filing, so
  you know a correction is needed.
- The W-2s can't be marked filed while any W-2 or the W-3 has problems.
- A filing record can be voided, never deleted.

## Demo script

1. Sign in to the demo company and open **Payroll › Tax forms** (Sample Landscaping Co. started
   payroll on January 1, so it has no prior payroll).
2. **Quarterly:** choose 2026 and Q3.
   - The September pay run is in the federal summary and the Texas unemployment wages.
   - **Mark filed** Form 941 with a confirmation number.
3. **Year end:** 2026 W-2s for Maria and David, the W-3 totals, and Q3 reconciled against the
   filed Form 941. Export the worksheet to Excel.
4. Void one of the September paychecks (from its pay stub), then return to **Quarterly**: Form 941
   lists what changed since it was filed.
5. For prior payroll, set **First payroll here** to a later date in Payroll › Setup on a test
   company, then add an employee's earlier pay under **Prior payroll**.

Screenshots: `docs/screenshots/90-quarterly-forms.png`, `91-w2-forms.png`, `92-prior-payroll.png`.

## Tests

| Suite                   | Count | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db`           | 83    | +3: prior payroll per employee and pay date, isolated by company, lines checked; one filed form per period, filings never deleted; tipped occupation codes                                                                                                                                                                                                                                                                                                 |
| `apps/api`              | 428   | +20. **Golden tests from the W-2 instructions:** boxes 3 and 5 at $199,750 (p.19), Alex's deferrals in box 12 (p.21), tips in box 7, code TT, the reconciliation rules (p.26), W-3 totals. **Summaries:** the federal quarter, FUTA year and state quarter. **End to end:** prior payroll rules and FUTA stopping at $7,000, W-2s adding prior payroll, the SSN export's permission and audit, filing locks, changes after filing, exports and permissions |
| `apps/web` (Playwright) | 12    | +1: enter prior payroll, check the quarter and state wage detail, mark Form 941 filed, check the W-2 and FUTA, and see prior payroll locked                                                                                                                                                                                                                                                                                                                |

## Not in this part

- The official Forms 941, 944, 940, W-2 and W-3 filled in, and the EFW2 file (item 57).
- 1099-NEC, 1099-MISC, 1096 and the IRIS file (item 57, and questions 17 and 20).
- State return layouts and upload formats (item 57).
- Deposits made before the first payroll here (59).
- Corrections: W-2c and 941-X (60).
