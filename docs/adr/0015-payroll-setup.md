# ADR 0015: Payroll setup, employees and direct deposit (Phase 8, part 1)

- Status: Accepted
- Date: 2026-09-30

## Context

Phase 8 builds payroll. The master plan requires the federal tax data
(`tax-data/<year>/federal.json`) to be built from IRS sources and checked by the product owner
before any tax code is written. The IRS and SSA sites are blocked from this environment for now
(open question 44). The owner asked for the parts of payroll that use no tax figures to go ahead
in the meantime:

- employer settings;
- pay schedules;
- state registrations;
- workers' compensation;
- PTO policies;
- payroll items;
- employees, with their withholding certificates, direct deposit, recurring deductions and PTO;
- the NACHA file format;
- contractors' Form W-9.

Supported states are California, Florida, Illinois, New York and Texas (`docs/states.md`).

## Decision

### No tax figures outside `tax-data`

- Nothing added here is a tax rate, wage base, threshold or table (CLAUDE.md rule 7).
- **Payroll items have a kind but no stored taxability.**
  - How each kind is taxed (federal income tax, FICA, FUTA and state) is tax law.
  - It will come from the year's tax data, keyed by kind, when the tax engine is built.
  - Nobody can mark a 401(k) as FICA-exempt by mistake, and the rules can change by year.
- **What employers enter is stored here**, because it comes from their own notices and policies:
  - their unemployment rate for each year, from the state's notice;
  - their workers' compensation rates, from their policy;
  - their state account numbers.
- Some defaults are editable wage-and-hour conventions, not tax:
  - overtime is 1.5 times the regular rate, and double time is 2 times;
  - pay dates that fall on a weekend move back to Friday.

### Company settings

- **Payroll is turned on** for a company by creating `payroll_settings`, one row per company.
- **The settings hold:**
  - the federal return (941 or 944) and the deposit schedule (monthly or semiweekly), both as
    the employer states them;
  - the default accounts: wage expense, tax expense and liabilities;
  - the bank account paychecks are paid from;
  - the direct deposit origination details: the ODFI's routing number and name, the company
    name and the ACH company ID.
- **Setting up payroll does two things:**
  - It picks the chart's Payroll Expenses › Wages, Payroll Expenses › Payroll Taxes and Payroll
    Liabilities accounts, falling back to the system accounts.
  - It creates the standard earnings items.
- Account types are checked on every save.
- Payroll uses the company's EIN, which is already encrypted on the company. When no ACH
  company ID is entered, the ID in the file is "1" followed by the EIN.

### Pay schedules

- Weekly and every-other-week schedules step from one period end.
- Twice-a-month schedules end on the 15th and the last day of the month.
- Monthly schedules end on the anchor's day, or the last day when the anchor is a month end.
- The pay date is the period end plus an offset, moved back to Friday if it falls on a weekend.
- The periods are computed in `@acct/shared` (`payPeriods`), so the web shows exactly what the
  API computes.
- A schedule cannot be turned off while current employees are paid on it.

### Employees

- **Identity and address:**
  - Personal details, a home address (for resident taxes such as New York City and Yonkers) and
    a work location.
  - The work state must be a supported state. The home state can be any state.
- **Job and pay:** hire and termination dates; pay type (hourly, salary or commission only);
  rate; usual hours; schedule; pay method; FLSA overtime exemption; workers' comp class; class
  and location.
- **Nothing is deleted:** an employee is terminated by entering a last day, never deleted. The
  app role has no `DELETE` on `employees`.
- **The SSN:**
  - It is encrypted with `FieldEncryptor`, using the AAD `employee:<id>:ssn`. The id is created
    before the insert so the value is bound to its row.
  - The ciphertext cannot be copied to another employee: a copied value fails to decrypt, and a
    test proves it.
  - The API returns only the masked form.
  - A reveal needs the new `payroll.sensitive.reveal` permission and is always audit-logged.
  - A changed SSN is audited as `ssnChanged: true`, without the value.
- **What still needs doing:** each employee lists what is missing before payroll can pay them
  correctly:
  - an SSN;
  - a Form W-4;
  - the work state's certificate;
  - a direct deposit account, when paid by direct deposit.

### Withholding certificates as history

- **Form W-4** (`employee_w4`):
  - Each row is effective from a date. Payroll will use the one in effect on the pay date.
  - 2020-and-later and pre-2020 forms are both kept.
  - The database enforces that each form has only its own version's fields: filing statuses,
    Steps 2 to 4, or allowances.
  - A new form is added; a mistaken one can be removed. Neither is edited in place.
- **State certificates** (`employee_state_certificates`):
  - The same pattern, with the fields as JSON validated by each state's schema in
    `@acct/shared`: IL-W-4, DE 4 and IT-2104.
  - A New Yorker lives in New York City or Yonkers, not both.
  - Texas and Florida have no state income tax and so no certificate.

### Direct deposit

- **Accounts:**
  - Up to three accounts per employee.
  - A fixed amount or a percentage of net pay, and exactly one account that gets the rest (the
    last one).
  - Percentages cannot exceed 100%.
  - Routing numbers are checked with the ABA check digit.
- **Encryption:**
  - Account numbers are encrypted with the AAD `employee_bank_account:<id>:account_number`.
    Only the last four digits are shown or audited.
  - Saving replaces the set but keeps each existing account's id, so an account's encrypted
    number stays valid without being entered again.
- **Prenotes:**
  - A new or changed account asks for one by default (`pending`).
  - The prenote file holds a zero-dollar entry for every pending account of current employees,
    using transaction codes 23 (checking) and 33 (savings). Creating it marks those accounts
    `sent`.
- **`PaymentRail`:** all files go through this interface.
  - Today's rail is `NachaFileRail`: an unbalanced PPD file (service class 220, credits only) for
    the employer to upload to their bank.
  - A payroll-payments partner can replace it and return its own reference instead.
- **Files are never stored:** a direct deposit file holds account numbers in clear text, as the
  format requires. It is returned to the caller and never stored or logged. `ach_batches`
  records what was generated: kind, settlement date, entry count, total and the file's SHA-256.
  The app can only insert and read that table.
- **NACHA records** (`payroll/nacha.ts`):
  - 94-character records, blocked in tens with `9` fill.
  - Entry hashes over the 8-digit RDFI routing numbers, and trace numbers from the ODFI.
  - Text is limited to upper-case printable ASCII.
  - Amounts must be whole cents.
- Bank-specific choices wait until an ODFI is chosen (open question 45): a balanced file, line
  endings, and the company ID.

### Contractors

- Form W-9 is recorded on the vendor: the date received, and whether backup withholding applies.
- The TIN is already encrypted there (ADR 0004).
- The backup withholding rate is tax data and comes with Phase 9's forms.

### Permissions

- `payroll.view` reads payroll; `payroll.manage` changes it (both existed).
- `payroll.sensitive.reveal` is new. It belongs to owners, admins, accountants and payroll
  admins.
- Payroll screens read accounts, vendors, classes and locations through `GET payroll/lookups`,
  so a payroll admin needs no ledger or purchases permission.

## Consequences

- Employers can finish all of payroll setup, and add employees with everything payroll needs,
  before the tax engine exists. Nothing here will change when the tax data arrives.
- The tax engine will read these facts:
  - the certificate in effect on the pay date;
  - the employer's unemployment rate for the year;
  - item kinds, with their taxability from tax data.
- Direct deposit accounts can be verified with prenotes ahead of the first payroll.
- Not done yet (after federal.json is signed off):
  - the `TaxEngine`, and state calculators for the five supported states;
  - pay runs (preview, approve, post), paychecks and pay stubs;
  - payroll deposit files;
  - liabilities with deposit due dates and the $100,000 next-day rule, and `EFTPSProvider`;
  - payroll reports;
  - the lookback calculation of the deposit schedule.
