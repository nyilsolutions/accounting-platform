# ADR 0019: Time tracking and progress invoicing (Phase 10b)

- Status: Accepted
- Date: 2026-09-30

## Context

Phase 10b adds time tracking (as in QuickBooks: time by employee or contractor, for a customer
and service, billable or not) and progress invoicing (invoicing an estimate in parts).

The owner decided (2026-09-30, "go with your recommendations"): **timesheets are approved by a
payroll admin or a manager before they feed paychecks or invoices.**

## Decision

### Time entries

`time_entries` (migration 0020) are hours worked on a date by an **employee or a vendor**
(contractor), never both. Each entry has:

- up to 24 hours, entered as decimals (7.5) or hours and minutes (7:30);
- optionally a customer (the job) and a service item (service, non-inventory or other charge);
- for employees, the **payroll item** it is paid as: an hourly earning (overtime, double time,
  vacation, sick, holiday), or empty for regular hourly pay;
- **billable** (needs a customer), with a billing rate. Without a rate it bills at the service's
  sales price;
- a class and notes.

### Weekly timesheets

- Weeks run Monday to Sunday.
- A timesheet's rows are activities (customer, service, pay-as, billable, notes) with hours for
  each day.
- Saving a timesheet replaces the week's open and rejected entries. Submitted and approved time
  in the week stays as it is.
- Single entries can also be added, changed and deleted, while they are open or rejected.

### Approval

| Status      | Meaning                                                           |
| ----------- | ----------------------------------------------------------------- |
| `open`      | Entered, not submitted; can change                                |
| `submitted` | Waiting for approval; locked                                      |
| `approved`  | Can be paid and billed                                            |
| `rejected`  | Sent back with a note; can change, and is open again once changed |

- Time is submitted a week at a time.
- **Who approves:**
  - members with the new permission `time.approve` (payroll admins, owners, admins,
    accountants);
  - the **manager** named on an employee (`employees.manager_user_id`), for that employee only.

  Contractors' time is approved by `time.approve`.

- An approval can be taken back while the time is neither paid nor billed.
- **Who enters time:** anyone with `time.manage` (the existing "Time tracking only" and standard
  roles). They enter time for any employee or vendor, as QuickBooks' time tracking role does.
  `GET /time/choices` gives them the customers, services and payroll items without the full
  lists.

### Paychecks

- When a **regular pay run** is created, an hourly employee with approved, unpaid time in the
  pay period is paid those hours, grouped by payroll item. The entries are linked to the paycheck
  (`paycheck_id`). Otherwise the default hours are used, as before.
- Salaried employees' time is informational.
- The paycheck notes "Hours come from approved time". It also shows how many hours in the period
  aren't approved and so aren't paid.
- Deleting a draft paycheck or run frees the time (the foreign key sets `paycheck_id` to null).
  Voiding a posted paycheck frees it too, so it can be paid again.
- Overtime isn't calculated from hours worked: time entered as overtime is paid as overtime.
  FLSA weekly and state daily overtime rules are not applied automatically.

### Billing time

- Invoice and sales receipt lines carry `timeEntryIds`. On save, the time must be approved,
  billable, for the document's customer and not billed on another document. The entries are then
  linked to the invoice and line (`invoice_id`, `invoice_line_no`).
- Removing a line, voiding or deleting the invoice frees its time.
- **"Add billable time"** on the invoice form adds a line per chosen entry: the service, hours ×
  rate, and a description with who and when.

### Progress invoicing

- Invoice lines may name an **estimate line** (`sales_lines.estimate_id`, `estimate_line_no`).
- What has been invoiced of an estimate line is the sum of those lines on posted invoices. It is
  computed, never stored, so voids and edits are always reflected.
- `POST /estimates/:id/progress-invoice` creates an invoice by:
  - **percent** of each line, capped at what remains;
  - **everything remaining**;
  - **an amount per line**.

  Lines with a quantity bill the same share of it (so inventory items keep a quantity).

- Saving any invoice that names estimate lines refuses to invoice more than a line's amount. The
  estimate is **closed** once everything is invoiced, and **reopened** (accepted) when an invoice
  is voided.
- A partly invoiced estimate can't be edited, deleted or converted whole. Converting an estimate
  now also records the estimate lines, so a voided conversion reopens the estimate.

### Reports

- Time by Customer Summary: hours, billable hours, unbilled hours and amount.
- Time Activities by Person Detail.
- Unbilled Time.
- Estimates Progress: amount, invoiced, remaining, % invoiced.

## Consequences

- Hourly payroll can run from approved timesheets, and billable time reaches invoices exactly
  once. Every link can be traced from the entry to its paycheck or invoice.
- **Not in this part:**
  - automatic overtime from hours worked;
  - a timer (start/stop);
  - billable expenses (costs marked billable on purchases);
  - employee self-service time entry (10f, portals).
