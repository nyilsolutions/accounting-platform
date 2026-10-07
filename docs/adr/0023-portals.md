# ADR 0023: Customer, employee and contractor portals (Phase 10f)

- Status: Accepted
- Date: 2026-10-07

## Context

The last part of Phase 10 gives three kinds of outside people their own way in:

- customers, to see and pay what they owe;
- employees, for their pay;
- contractors (1099 vendors), for their payments.

None of them may ever see the company's books.

The owner decided (2026-10-07):

- **Customers** sign in with an **emailed link**. They can:
  - see open and paid invoices and their statement;
  - pay online (10e);
  - accept or decline estimates sent to them.

  Nothing else is editable.

- **Employees** use a **password and MFA**. They can:
  - see their pay stubs and W-2 figures;
  - enter and submit their own timesheets (10b approvals apply);
  - see their W-4 and direct deposit (masked).

  **Changes to the W-4 or direct deposit are requests a payroll admin approves**, because
  self-service bank changes are the classic payroll-fraud route.

- **Contractors** use a **password and MFA**. They can:
  - enter and submit their time;
  - see the payments made to them and their 1099 totals.

  Their TIN stays with the business.

- **Accounts:** employees and contractors use the **normal sign-in** (password, MFA, reset),
  linked to their own record with **no company membership**. One person can be linked in several
  companies, and a staff member can also see their own pay stubs.

## Decision

### Employees and contractors: links, not memberships

- `portal_links` (migration 0025) ties a user to one employee or one vendor in a company.
  - A link starts as an **invitation**: the SHA-256 of a token emailed to `/portal/invite/<token>`.
    It expires after `INVITATION_TTL_DAYS`, and a new invitation replaces one not yet accepted.
  - The **user who accepts** must sign in with the invited email and have completed MFA (the
    global session guard), exactly like a staff invitation.
  - There is one live link per employee, per vendor, and per user per company.
  - **Revoking** a link ends access at once.
- **Who invites:**
  - inviting employees and removing their access needs `payroll.manage`;
  - for contractors it needs `purchases.manage`;
  - the employee page and the vendor page have a **Portal access** card.
- **No membership:** a link creates none, so `CompanyAccessGuard` keeps returning 404 for every
  company route.
- **The portal's own guard:** routes are under `portal/c/:companyId`, and `WorkerPortalGuard`
  admits only a person with a live link there (404 otherwise).
- **Reading their records:** every read checks the record is the person's own (the paycheck's
  employee, the vendor's payments) before calling the normal service. That call gets a
  **narrow company context** with only the permission it needs:
  - `payroll.view` for a pay stub or the W-2;
  - `company.view` and `time.manage` for their own timesheet.

  The worker is always the link's, never taken from the request.

- **Lookups without a company:** `app_find_portal_invite` and `app_portal_links_for_user`
  (security definer) answer invitation previews and "where do I have access" with ids and names
  only.
- **The web:**
  - The portal is `/portal`: a list when there is more than one company, else straight in.
  - `/portal/c/<company>` has these tabs:
    - employees: **Pay stubs**, **Time**, **W-2**, and **W-4 and direct deposit**;
    - contractors: **Payments**, **Time** and **1099**.
  - Someone with portal access and no companies is sent from `/companies` to `/portal`; staff
    with a link see a link to it.
  - The pay stub reuses the staff statement (`PayStubStatement`) without the staff actions;
    printing is the browser's (as everywhere).

### Employee change requests

- **Storing a request:** `employee_change_requests` holds a W-4 (the W-4 input as entered) or
  new direct deposit accounts.
  - The accounts, numbers included, are stored only **encrypted**, with the row-bound AAD
    `employee_change_request:<id>:bank_accounts`.
  - A **masked summary** is what the employee, the reviewer, the audit log and the emails see.
  - There is one open request of each kind per employee; the employee can withdraw it.
- **Telling approvers:** owners, admins and payroll admins are emailed.
- **Reviewing:** in **Payroll › Employee requests** (`payroll.manage`).
  - **Approving** applies the request through `EmployeesService.addW4` (a new certificate in the
    effective-dated history) or `setBankAccounts` (the set replaced). Accounts an employee
    entered are **always prenoted**.
  - The request is then marked approved, and the employee emailed.
  - **Rejecting** takes an optional note.
- **Scope:** only the federal W-4 (2020 form); state certificates stay with the payroll admin
  (question 73).

### Employees' and contractors' figures

- **W-2:** the figures come from `TaxFormsService.w2` filtered to the person, with filing
  problems hidden. The current year is shown "so far".
  - This is **not furnishing the W-2**: that needs a consent step first (question 72).
- **Contractor payments:** posted bill payments, checks and expenses naming the vendor, by year.
- **Contractor 1099 totals:** from `vendor1099Summary` filtered to the vendor, with each box's
  reportability.
- **Portal timesheets:** a note and hours per day. They map onto 10b's timesheet as regular,
  non-billable time (question 71). Submitting sends it to the normal approvals.

### Customers: emailed links and their own session

- **Asking for a link:** at `/portal/customer` the customer enters their email.
  - `app_customers_by_email` finds active customers with that email in every company, and one
    email carries a link per company.
  - The answer never says whether the email was found, and the route is throttled like sign-in.
- **Links:** `customer_portal_tokens` holds the hashed one-time links.
  - A link the customer asks for lasts **15 minutes**.
  - **Invite to customer portal** on a customer's page sends one that lasts **7 days**.
  - Either works once.
- **Sessions:** opening a link creates a row in `customer_portal_sessions`, behind its own
  cookie (`acct_portal`, httpOnly, `__Host-` when secure).
  - It is separate from the staff session: a staff cookie never opens it, and it never opens the
    books.
  - It lasts 12 hours, with the staff idle timeout.
  - Signing out revokes it.
- **What the session allows:** everything is scoped to that customer.
  - **Invoices:** posted invoices of the last two years, with their balance from the A/R
    subledger (open, overdue or paid), and the invoice in full.
  - **Paying** makes a 10e pay link (`createPayLink`), and 10e's pay page takes it from there
    (only while the business takes online payments and the invoice is in US dollars).
  - **Statement:** `ArService.statementInTx` for a date range.
  - **Estimates** that were sent to them can be **accepted or declined** while pending, not
    expired and not invoiced. This is audited ("by customer portal") and the business is
    emailed.
- **Linking in:** the 10e pay page links to the customer portal.

## Consequences

- Outside people get what they need without any role that can open the books. The guard
  that protects company routes is unchanged, and each portal has its own narrow guard.
- Payroll-sensitive changes keep a person in the loop; account numbers never appear outside
  the encrypted request and the employee's own record.
- Reusing the normal services (with a narrow context) keeps the numbers identical to what staff
  see: the same pay stub, the same W-2 figures, the same statement.

## Not in this part

- Official W-2 copies and their electronic delivery (question 72).
- Earnings and customers on portal timesheets (question 71).
- State certificate requests (question 73).
- Customers editing their details (decided against).
