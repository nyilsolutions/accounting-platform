# ADR 0026: A licensed state tax engine beside the built-in one (Phase 11c)

- Status: Accepted
- Date: 2026-10-07

## Context

The built-in payroll tax engine (ADR 0016) calculates federal taxes and five states: California,
Florida, Illinois, New York and Texas. Every figure it uses comes from sourced `tax-data`. The
other 45 states, DC and thousands of local taxes can't be sourced and kept current by hand. A
payroll product buys them from a **licensed tax engine**, or hands payroll to an **embedded
payroll provider** that does taxes, filing and payments itself.

The owner decided (2026-10-07):

- **Scope:** a plug-in point for a licensed engine. The built-in engine keeps its five states. A
  licensed engine calculates any other state and its local taxes. General state and local tax
  codes flow through paychecks, liabilities and W-2 boxes 15–20. The embedded provider is
  designed here only.
- **No stand-in:** until an engine is contracted, paychecks in other states are refused with the
  reason. Tests use a fixture engine whose figures each test programs. **No invented tax amount
  ever reaches a paycheck.**

## Decision

### Any state can be set up; its taxes need a calculator

- **All states:** employees, state registrations, workers' comp classes, tax filings and the
  state quarterly report accept any of the 50 states and DC (`PAYROLL_WORK_STATES`).
  `PAYROLL_STATES` stays the built-in engine's five.
- **Who calculates:** each registration says who calculates its taxes (`taxSource`):
  - `built_in`;
  - `tax_engine`, with the engine's name;
  - `none`.

  Payroll › Setup shows it, and "Needs a licensed tax engine" for `none`.

### The interface

`StateTaxEngine` (`payroll/tax/state-tax-engine.ts`):

- `supports(state)`.
- `calculate(request)` returns lines and notices, or a refusal with reasons.
- **The request carries:**
  - the pay date, frequency and supplemental flag;
  - the work state;
  - the work and home addresses (locality taxes depend on both);
  - the paycheck's earnings, deductions and contributions by kind;
  - the employer's unemployment rate;
  - the year's earlier engine taxes by code, payer, state and jurisdiction, for wage bases.

  It never carries the SSN or any bank number.

- **Lines use five codes:**
  - `state_income` and `state_unemployment`, paid by the employee or the employer;
  - three new codes: `state_other` (a state tax other than income or unemployment, such as a
    disability or leave fund), `local_income` and `local_other`. Each names its jurisdiction
    (`jurisdiction_code` and `jurisdiction_name` on `paycheck_lines`, migration 0028).

### Checking every answer

`checkStateTaxAnswer` refuses the whole answer if any line:

- has an unknown code, or a payer that doesn't fit (state income tax is the employee's);
- is for another state than the work state;
- lacks a jurisdiction where one is needed, or has one where it isn't;
- has an amount that isn't non-negative dollars and cents;
- repeats a tax.

An engine that throws or doesn't answer refuses the paycheck with "didn't answer". Its message is
neither shown nor logged, because it may echo the request. Refusals are paycheck problems, so the
run can't be approved until they are fixed.

### Paychecks

- **Built-in states:** `calculatePaycheckTaxes` handles federal and the five states as before.
- **Any other work state:** the pay run service builds the paycheck once to get its items, asks
  the engine, and builds it again with the checked answer (`externalState`).
- **Federal taxes** always stay the built-in engine's.
- **No engine:** the paycheck is refused with "<State> payroll taxes aren't built in. They need a
  licensed tax engine, and none is set up on this platform yet."
- **Configuration:** `PAYROLL_TAX_ENGINE` is `none` (the default) or `test-fixture`. The fixture is
  refused unless NODE_ENV=test.

### After the paycheck

- **Liabilities:**
  - `state_income` is owed to `state_withholding:<ST>` and `state_unemployment` (both payers) to
    `state_unemployment:<ST>`;
  - `state_other` is owed to `state_other:<ST>:<jurisdiction>`, and local taxes to
    `local:<ST>:<jurisdiction>`. Both are labelled with the jurisdiction's name.

  Their due dates aren't in tax-data, so they show "no due date" with a note. The database check
  on payment agencies accepts the new forms.

- **W-2:**
  - boxes 15–17 come from `state_income` lines in any state;
  - boxes 18–20 come from `local_income` lines (the locality is the jurisdiction name);
  - the employee's other engine taxes, and unemployment tax withheld from employees, go in box 14
    (question 82).
- **State quarterly:**
  - employer unemployment tax is the wage detail;
  - the engine's employee taxes are listed with withholding, by jurisdiction;
  - its employer taxes are listed under other employer taxes;
  - local taxes carry a note that they are usually filed with each locality.
- **Stubs, run totals, postings and payroll reports** label engine lines with the jurisdiction
  name.
- **Prior payroll** accepts `state_income` and `state_unemployment` in any state, but not the
  engine-only codes yet (question 83).

### The embedded provider (design only)

If the owner chooses an embedded payroll provider instead, it replaces more than taxes:

- **What changes:** the provider runs the payroll. It calculates paychecks (federal, state and
  local), files returns, pays the agencies and moves the money.
- **What the platform keeps:** the books. It becomes the provider's client.
- **The seam:** a `PayrollProvider` interface at the pay run level, not at taxes:
  - **Onboarding:** create the company, sync employees and their tax forms, and go through the
    provider's own onboarding (bank verification, agency registrations).
  - **Runs:** create a pay run, preview the paychecks, approve, then cancel or void.
  - **Read back:** posted paychecks with their lines (earnings, deductions and taxes by
    jurisdiction), tax payments and filings, and the money movements.
- **What the platform does with each provider paycheck:**
  - stores it as a `paychecks` row with the provider's lines, using the same codes and
    jurisdictions as 11c, so stubs, reports, the W-2 view and the books work unchanged;
  - posts it through PostingService (wages, withholding and the clearing of net pay);
  - records each tax payment and return the provider makes as a liability payment and a filing,
    with the provider's reference.
- **What the platform switches off** for provider companies (a per-company `payroll_mode`):
  - its own tax calculation, e-file (11a), EFTPS and NACHA (11b);
  - liabilities owed to agencies, which the provider pays. They show as paid by the provider
    instead.
- **Webhooks** from the provider (paycheck voided, payment returned, filing accepted) feed the
  same status handling as the 11a and 11b pollers.

Nothing of this is built until the owner chooses (question 81).

## Consequences

- **Plugging in an engine:** a contracted engine becomes one class plus a `PAYROLL_TAX_ENGINE`
  value. Paychecks, liabilities, forms and the books need no change.
- **Without an engine,** companies can still set up employees in any state, but those paychecks
  can't be approved. The reason is shown on the paycheck and the setup screen.
- **The engine is asked inside the pay run's transaction.** A real engine needs a timeout well
  under a request's limits (question 81).

## Not in this part

- **A real engine or provider,** and its terms (question 81).
- **Withholding certificates** for other states (the engine's inputs, such as a state W-4),
  reciprocity and residence-state withholding (question 82).
- **Engine-only codes in prior payroll** (question 83).
