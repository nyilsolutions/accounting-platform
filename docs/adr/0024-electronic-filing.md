# ADR 0024: Electronic filing of Forms 941, 940 and 1099 (Phase 11a)

- Status: Accepted
- Date: 2026-10-07

## Context

Phase 11 connects the platform to the IRS and to payroll partners. The master plan lists:

- **IRS Modernized e-File (MeF)** for Forms 941 and 940, with an Assurance Testing System (ATS)
  harness;
- **IRIS** system-to-system (A2A) filing for Forms 1099;
- **EFTPS** batch payments;
- a **licensed state tax engine** or an **embedded payroll provider**;
- a **direct deposit partner**.

None of these can be finished yet:

- **The specifications aren't available.** The MeF and IRIS schemas, business rules and ATS
  scenarios, the EFTPS batch specification and every partner's API documents are on sites this
  environment can't reach.
- **The accounts and approvals don't exist yet:** an ETIN, an IRIS TCC, EFTPS batch enrollment
  and a partner contract.

The owner decided (2026-10-07):

- **Build the framework and stand-ins now.** The real MeF, IRIS, EFTPS and partner adapters plug
  in when the documents and credentials arrive.
- **The long-term partner is decided later.** Keep both an in-house IRS route and an embedded
  provider possible.
- **Direct deposit stays a NACHA file** the employer uploads, with a partner behind
  `PaymentRail` later. Question 45 (the ODFI) stays open.

Phase 11 is in parts, as Phase 10 was:

- **11a** (this ADR): electronic filing.
- **11b:** EFTPS batch payments and the payments-partner rail.
- **11c:** the plug-in point for a licensed tax engine or an embedded provider.

## Decision

### One interface to the IRS

- **`EfileTransmitter`** (`apps/api/src/efile/transmitters/`) is the only way returns leave.
  A transmitter has:
  - a name and an environment: `test` (the IRS's ATS: nothing is filed) or `production`;
  - `transmit(return)`, which resolves with the IRS submission id once the return is received;
  - `acknowledgments(channel, ids)`, the answers that are ready.
- **The channel follows the form:** MeF for Forms 941 and 940, IRIS for Forms 1099.
- **The return is the platform's own:** an `EfileReturn` holding the filer, the signer and the
  form's figures (the same Phase 9 figures the forms show), or the 1099 recipients. Each
  transmitter serializes it for its channel. The MeF and IRIS XML is written when the schemas
  arrive.
- **Secret numbers:** the return carries the full EIN and TINs, decrypted only to build it.
  Neither the transmitter nor the service stores or logs them.
- **The stand-in** (`StandInTransmitter`) plays the IRS for development, tests and demos, as the
  payments stand-in does for Stripe (ADR 0022).
  - It holds each return until someone answers for the IRS (**Stand-in: accept / reject** in the
    app).
  - It may not run in production: `EFILE_TRANSMITTER` must be `none` there until a real
    transmitter exists.
  - With `none`, the forms say electronic filing isn't set up, and "Mark filed" works as before.

### A submission per send

`efile_submissions` (migration 0026) records every return sent.

- **Written before sending.** The submission is committed as `sending` before the transmitter is
  called, so a return that may have reached the IRS is never lost track of.
- **After the call:**
  - received: it becomes `transmitted`, with the submission id;
  - certainly not received (`EfileTransmitError`): it becomes `failed`, with the message;
  - no answer: it stays `sending`. After ten minutes the user may mark it **not sent**, once
    they know it never reached the IRS.
- **One at a time:** one return per form and period can be in flight (a unique index), and
  "Mark filed" is refused meanwhile.
- **What it keeps:**
  - the snapshot of the figures as sent (as a filing does, without SSNs, EINs or TINs);
  - the signer (name, title, phone, email);
  - the acknowledgement's errors.
- **Never deleted:** submissions are kept, like filings.

### Before sending

The platform's own checks are listed on the form until they're fixed:

- the company's EIN and full address;
- a finished period;
- for Forms 1099, at least one vendor meeting a threshold, and each such vendor's TIN and full
  address.

The IRS's own business rules come back in the acknowledgement.

The signer confirms, in the app's own words, that the return is true, correct and complete and
that they may sign it. The forms' official statement and the electronic signature method wait on
the documents (question 75).

### Acknowledgements

- **How they arrive:**
  - a poller asks the transmitter every 15 minutes (`EFILE_ACK_POLLER`);
  - **Check for the IRS's answer** asks now;
  - the stand-in's answer is applied at once.
- **Lookups:** the poller finds waiting returns across companies through the security-definer
  lookup `app_efile_waiting` (ids only), then works inside each company with `withTenant()`.
- **Accepted** (production): records the form's filing in `tax_filings`.
  - It is the same record "Mark filed" makes: method electronic, the submission id as the
    confirmation, filed on the date it was sent, and the snapshot as sent.
  - Later changes are listed as differences needing a correction.
  - The filing record can't be voided, because the IRS has the return.
  - A filing already marked by hand is linked instead of duplicated.
- **Rejected:** shows the IRS's errors. Once they are fixed, **Send again** creates a new
  submission linked to the rejected one.
- **Emails:** the person who sent the return is emailed either way.
- **Test environment:** an accepted return in `test` records nothing.

### Forms 1099 get a filing record

- Forms 1099 join the filing records (`tax_filings.form = 'form_1099'`).
  - Their snapshot is the year's 1099 summary without TINs.
  - The 1099 page shows the filing and what changed since.
- **Not payroll forms:** payroll's filing routes and list exclude them, and they never lock prior
  payroll (`filingCovering`).
- **Permissions:**
  - Forms 941 and 940: `payroll.view` to read and `payroll.manage` to send or answer;
  - Forms 1099: `purchases.view` and `purchases.manage`, under `/1099/…`.

### The ATS harness

`apps/api/src/efile/ats/` loads scenarios from `/efile-ats/<tax year>/*.json`.

- **A scenario** is the filer, the signer, and the figures or recipients, with where it comes
  from.
- **What it checks:** that each scenario is complete. The figure fields are checked against the
  form's DTO at compile time.
- **Sending:** it builds the same `EfileReturn` the app sends, transmits it, waits for the
  acknowledgements, and reports each outcome against what the scenario expects.
- **Test only:** it refuses any transmitter not in the test environment.
- **Scenarios so far:** only samples marked as such. The IRS's scenarios are added with the
  documents (question 74).
- **How to run it:** `pnpm --filter @acct/api ats -- --year 2026` (`--stand-in-answer accept`
  for a dry run).

## Consequences

- When the IRS approvals arrive, adding a real channel means writing one transmitter (serialize,
  send, fetch acknowledgements). Nothing else changes: the forms, the filing records, the
  rejection loop and the harness stay as they are.
- A return is never sent twice by accident, and one that may have been sent is never forgotten.
- Stand-in filings are real filing records in development and demos, as stand-in payments are
  real payments in the books. Production can't run the stand-in.

## Not in this part

- **The MeF and IRIS transmitters themselves**, which wait on the documents and approvals
  (question 74).
- **Electronic signatures** for Forms 941 and 940 (question 75).
- **W-2s to the SSA:** EFW2 is uploaded through Business Services Online, which has no
  system-to-system channel, and the file waits on SSA Publication 42-007 (question 57).
- **State returns.**
- **Corrected returns** (941-X, corrected 1099s), still listed as differences (question 60).
- **Form 944.**
