# ADR 0025: EFTPS batch payments and a direct deposit partner (Phase 11b)

- Status: Accepted
- Date: 2026-10-07

## Context

Until now, payroll money has left the platform two ways:

- **Federal taxes:** the company pays them in EFTPS itself and types the EFT number in
  (`ManualEftpsProvider`, Phase 8).
- **Direct deposits:** a NACHA file the company uploads to its own bank (`NachaFileRail`).

Phase 11b adds the platform-run routes behind stand-ins, as 11a did for e-file. Neither the
Treasury's batch provider enrollment nor a payments partner contract exists yet.

The owner decided (2026-10-07):

- **EFTPS:** the platform acts as each company's **EFTPS batch provider**. The company enrolls
  once with the bank account EFTPS debits. No money passes through the platform.
- **Recording payments:** a payment is recorded in the books **when it is scheduled**, dated its
  settlement date with its EFT acknowledgement number. If it is cancelled or comes back unpaid, it
  is voided automatically and the tax shows as owed again, and the payroll admins are emailed.
- **Direct deposit:** the **NACHA file stays the default**. A company can choose the payments
  partner instead.
- **Returned deposits:** the paycheck is **flagged**, the employee's account is turned off and the
  payroll admins are emailed. **Nothing is posted automatically.** They void the paycheck, which
  puts the money back in the bank in the books, and pay it again by check.

## Decision

### EFTPS through the batch provider

- **`EftpsBatchProvider`** (`payroll/partners/eftps-batch.ts`) is the only way to reach EFTPS.
  It handles:
  - enrolling a company, and fetching enrollment decisions;
  - scheduling a payment, which returns the EFT acknowledgement number;
  - cancelling a payment;
  - fetching settled and returned payments.
- **The stand-in** (`StandInEftpsBatch`) holds each request until someone answers for EFTPS in
  the app. Production refuses it: `EFTPS_BATCH_PROVIDER` must be `none` there.
- **Enrollment** (`eftps_enrollments`, migration 0027):
  - It records the debit account, encrypted with the AAD
    `eftps_enrollment:<id>:account_number` and shown masked.
  - It records who authorized the debits, with their title and a statement in the app's own
    words.
  - There is one live enrollment per company. It is written as pending before the provider is
    asked; if the provider refuses or doesn't answer, it is marked rejected so it can be retried.
- **Paying:** `EftpsService.pay` replaces the liabilities route's `pay`.
  - **Company not enrolled, or not EFTPS:** nothing changes (manual instructions, as before).
  - **Enrolled company, EFTPS method:**
    1. `PayrollLiabilitiesService.payInTx` records and posts the payment as `sending`, with no
       reference, and that is committed.
    2. The provider is called.
    3. The payment becomes `scheduled` with its EFT number. If the provider refuses it, it becomes
       `failed` and is voided. If there is no answer, it stays `sending` until someone marks it not
       sent (after ten minutes), which voids it.
- **After scheduling:**
  - **Cancel EFTPS payment** cancels it with the provider, then voids it (`cancelled`).
  - A scheduled or sending payment can't be voided in the books directly.
  - **Settled** marks it paid.
  - **Returned:**
    - it is voided (`returned`), and the payroll admins are emailed;
    - if its period is closed, it stays posted and the email says to void it with the closing
      password.
- **Secret numbers:** the full EIN and account number are decrypted only to build requests, and
  are never stored in clear, audited or logged.

### Direct deposit through the payments partner

- **`DepositPartner`** (`payroll/partners/deposit-partner.ts`) submits a batch and reports
  settlement and the entries that came back. The stand-in is `StandInDepositPartner`.
- **The company's choice:** `payroll_settings.deposit_rail` is `nacha_file` or `partner`. The
  NACHA file and prenote file routes refuse partner companies, and the partner routes refuse the
  others.
- **Sending:**
  - The batch (`ach_batches` with `rail = 'partner'`) and one `direct_deposit_entries` row per
    deposit or prenote are written as `sending` before the partner is called.
  - The batch then becomes `submitted` (with the partner's reference) or `failed`.
  - A failed batch doesn't count against the run's one batch, so it can be sent again.
- **Returns:** a returned entry (code and reason, applied once):
  - flags its paycheck (`depositReturns` on the paycheck);
  - turns the employee's account off (`returned_at` on `employee_bank_accounts`);
  - emails the payroll admins.

  A direct deposit paycheck to that account is then a pay-run problem until the account is
  changed or **It's fixed: use it again** clears it. Nothing is posted.

- **Settlement:** a settled batch marks its other entries paid.

### Updates

- **How they arrive:**
  - a poller asks both providers every 15 minutes (`PAYROLL_PARTNER_POLLER`);
  - **Check now** asks for one company;
  - the stand-ins' answers apply at once.
- **Lookups:** pending enrollments, scheduled payments and submitted batches are found across
  companies through `app_payroll_partner_waiting` (ids and references only), then handled inside
  each company with `withTenant()`.

## Consequences

- When a real provider or partner is contracted, adding it means writing one class against the
  interface. The books, the statuses, the emails and the screens stay as they are.
- A tax payment or deposit that may have gone out is never lost track of, and a run is never paid
  twice by accident.
- The books follow the decision: scheduled tax payments count as paid until they come back.

## Not in this part

- **The Treasury batch provider enrollment** and its specifications, the real cut-off times and
  how cancellations work (question 77).
- **The partner itself:** its onboarding of each company and funding account, and returns that
  arrive after settlement (question 78). Once settled, a batch isn't polled any more.
- **State tax payments** through the provider.
