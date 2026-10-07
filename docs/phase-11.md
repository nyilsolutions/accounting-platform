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
- **Direct deposit stays a NACHA file** the employer uploads; a partner goes behind
  `PaymentRail` later.

| Part | What                                                              | Status  |
| ---- | ----------------------------------------------------------------- | ------- |
| 11a  | Electronic filing of Forms 941, 940 and 1099, and the ATS harness | This PR |
| 11b  | EFTPS batch payments and a payments partner, with stand-ins       | Next    |
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
