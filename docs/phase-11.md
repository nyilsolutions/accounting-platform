# Phase 11: E-file and partners

Phase 11 connects the platform to the IRS and to payroll partners. Neither can be finished yet:

- **The specifications aren't available.** The IRS's e-file schemas, business rules and test
  scenarios, the EFTPS batch specification and the partners' API documents are out of reach
  here.
- **The accounts don't exist yet:** an ETIN, an IRIS TCC, EFTPS enrollment and a partner
  contract.

The owner decided (2026-10-07):

- **Build the framework with stand-ins now.** The real adapters plug in when the documents and
  credentials arrive.
- **The long-term partner is decided later:** the IRS route in-house with a licensed state
  engine, or an embedded payroll provider.
- **Direct deposit stays a NACHA file** the employer uploads by default; a payments partner is
  added beside it (11b).

| Part | What                                                              | Status  |
| ---- | ----------------------------------------------------------------- | ------- |
| 11a  | Electronic filing of Forms 941, 940 and 1099, and the ATS harness | This PR |
| 11b  | EFTPS batch payments and a payments partner, with stand-ins       | This PR |
| 11c  | A plug-in point for a licensed tax engine or an embedded provider | Planned |

## 11a: Electronic filing (ADR 0024)

### Delivered

- **E-file on each return:** Form 941 (Payroll › Tax forms › Quarterly), Form 940 (Year end)
  and Forms 1099 (Expenses › 1099 contractors) each have a **File electronically** panel.
  - **Before sending**, it lists what must be fixed: the company's EIN and address, a finished
    period, and each 1099 vendor's TIN and address.
  - **E-file** asks for the signer (or, for Forms 1099, the contact): name, title, phone and
    email, plus their statement that the return is true and complete.
  - **While it waits for the IRS**, **Check for the IRS's answer** asks right away; the platform
    also asks every 15 minutes.
  - **Accepted:** the return is recorded as filed (electronically, with the submission ID as the
    confirmation). Later changes are listed as differences needing a correction, and the
    filing record can't be voided.
  - **Rejected:** the IRS's errors are listed. Fix them and **Send again**, which is linked to
    the rejected return.
  - **No confirmation from the transmitter:** if it never confirmed receiving the return,
    **It wasn't sent** frees the return to be sent again (after ten minutes).
  - **Emails:** the sender is emailed when the IRS answers.
- **The E-file tab** (Payroll › Tax forms › E-file) lists every Form 941 and 940 sent, with
  status, submission ID, dates, sender and errors.
- **Forms 1099 have a filing record**, like the payroll forms: **Mark filed** on the 1099 page,
  with what changed since filing.
- **The stand-in for the IRS:** until the platform's IRS approvals arrive, returns go to a
  stand-in, and **Stand-in: accept / reject** plays the IRS's answer. Production can't use it
  (`EFILE_TRANSMITTER=none` there).
- **The ATS harness** sends test scenarios to the IRS's test system and reports each outcome:
  `pnpm --filter @acct/api ats -- --year 2026`. The scenarios in `/efile-ats/2026` are samples
  for now.

### Demo script

1. Sign in as the demo user. Open **Payroll › Tax forms › E-file**:
   - last quarter's Form 941 was **rejected** by the stand-in (the business name doesn't match
     the EIN);
   - the quarter before was **accepted**.
2. **Quarterly**, last quarter: the panel shows the error. Choose **Send again**, confirm the
   statement and send. The return waits for the IRS.
3. Choose **Stand-in: accept**. The panel shows **Accepted**, and the filing record below it
   says **Filed electronically**, with the submission ID as the confirmation.
4. **Expenses › 1099 contractors**, last year: if a vendor lacks a TIN or address, the panel
   names it. Fix it on the vendor, then **E-file Forms 1099**.

Screenshots: `docs/screenshots/119-efile-941.png`, `120-efile-log.png`, `121-efile-1099.png`.

### Tests

| Suite                   | Count | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db`           | 111   | +4: one return in flight per form and period, kept within the company; an accepted production return needs its filing, the test system's doesn't; a failed one needs its message; never deleted; the waiting lookup returns ids only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/shared`       | 156   | +3: a quarter for Form 941 only, the signer's statement, signer fields; the stand-in's rejection needs an error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/api`              | 563   | +11. **Before sending:** missing address, unfinished periods, 1099 vendors without TIN or address; Forms 1099 refused on payroll's routes. **Form 941:** sent, one at a time, "Mark filed" refused meanwhile; rejected with errors and an email; sent again (linked); accepted, recorded as filed electronically and not voidable. **Secrets:** no EIN or SSN in submissions or the audit log. **Failures:** a refused send is failed; an unknown one stays sending until marked not sent. **Polling** and "check now". **Forms 1099** through IRIS, their filing record and later differences, kept out of payroll's routes. **No transmitter** configured. **ATS harness:** samples complete, outcomes against expectations, incomplete scenarios, failed sends and missing answers, never production |
| `apps/web` (Playwright) | 19    | +1: Form 941 shows the missing address, is sent signed, rejected by the stand-in, sent again and accepted (filed electronically, no void); the E-file log lists both; Forms 1099 for last year sent through IRIS and filed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### Not in this part

- **The IRS's own transmitters** (MeF and IRIS), which wait on the documents and approvals
  (question 74).
- **The electronic signature method** for Forms 941 and 940 (question 75).
- **W-2s to the SSA** (uploaded through BSO, and waiting on Publication 42-007, question 57).
- **State returns, corrected returns and Form 944.**

## 11b: EFTPS batch payments and the direct deposit partner (ADR 0025)

The owner's decisions (2026-10-07):

- **EFTPS:** the platform is each company's EFTPS batch provider. No money passes through the
  platform.
- **Recording payments:** a payment is recorded when it is scheduled, and voided automatically if
  it is cancelled or comes back.
- **Direct deposit:** the NACHA file stays the default.
- **Returned deposits:** they are flagged for the payroll admin to reissue, not posted.

### Delivered

- **EFTPS enrollment** (Payroll › Taxes & liabilities): **Enroll in EFTPS** takes the account
  EFTPS debits (stored encrypted, shown masked) and the person authorizing it.
  - EFTPS's answer comes back as enrolled or not, with an email to the payroll admins.
  - **Cancel enrollment** stops scheduling.
- **Scheduled tax payments:** once enrolled, paying a federal liability by EFTPS schedules it for
  you, on the next business day by default. It is recorded in the books with its EFT number and
  shows as **Scheduled**.
  - **Cancel EFTPS payment** cancels and voids it.
  - **Paid** when EFTPS settles it.
  - **Returned unpaid:** it is voided, so the tax is owed again, and the payroll admins are
    emailed.
  - Refused or never confirmed payments are shown as such and can be paid again.
- **Payments partner for direct deposit** (Payroll › Direct deposit): **Send through the payments
  partner** replaces the NACHA file for the company.
  - Pay runs get **Send direct deposits** and prenotes get **Send prenotes**.
  - Each batch lists its deposits.
- **Returned deposits:** a returned deposit:
  - shows its return code on the batch;
  - adds a notice on the paycheck (void it and pay it again by check);
  - marks the employee's account (**It's fixed: use it again**);
  - emails the payroll admins.

  The next paycheck can't be deposited to that account until it is fixed.

- **Updates:** the platform asks EFTPS and the partner for updates every 15 minutes. In stand-in
  mode, buttons play their answers.

### Demo script

1. Sign in as the demo user. **Payroll › Taxes & liabilities**: the company is **Enrolled** in
   EFTPS (stand-in), and its oldest Form 941 deposit is **Scheduled** for the next business day.
2. Choose **Stand-in: returned**. The payment shows **Returned unpaid**, its amount is owed again,
   and the payroll admins are emailed. Pay it again with **Pay**: it is scheduled.
3. **Payroll › Direct deposit**: choose **Send through the payments partner**. Open a posted pay
   run with direct deposits and choose **Send direct deposits**.
4. Back on **Direct deposit**, choose **Stand-in: return** on a deposit. It shows **Returned R03:
   No account**. The paycheck says to void it and pay it again, and the employee's page marks the
   account.

Screenshots: `docs/screenshots/122-eftps-scheduled.png`, `123-partner-deposits.png`.

### Tests

| Suite                   | Count | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db`           | 115   | +4: one live enrollment per company, kept within it and never deleted; each batch tied to its rail (a NACHA file keeps its hash, a partner batch its reference); only a partner batch's status moves, forward; returns need their code, prenotes have no paycheck; the waiting lookup returns ids and references only                                                                                                                                                                                                                                                                                                      |
| `packages/shared`       | 158   | +2: enrollment needs a valid routing number, the account and the authorization; returns need an R code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `apps/api`              | 574   | +11. **EFTPS:** manual until enrolled; enrollment rejected then accepted, with emails, the account number never stored in clear or audited; a payment scheduled, booked, not voidable while scheduled, then settled; one returned unpaid is voided and owed again, with an email; cancelling; a refused one and an unknown one (marked not sent after ten minutes); polling. **Partner:** the company switches, the NACHA file is refused; a failed batch can be sent again, then once per run; a returned deposit flags the paycheck and the account, emails, blocks the next deposit until cleared; settlement; prenotes |
| `apps/web` (Playwright) | 20    | +1: enroll in EFTPS (stand-in), schedule the Form 941 deposit, see it returned unpaid; switch to the payments partner, send a run's deposits, a return shows on the batch, the paycheck and the employee, and is cleared                                                                                                                                                                                                                                                                                                                                                                                                   |

### Not in this part

- **The Treasury's batch provider enrollment** and the EFTPS specifications (question 77).
- **The payments partner itself** (question 78).
- **State tax payments** through a provider.
