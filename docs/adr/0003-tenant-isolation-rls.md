# ADR 0003: Tenant isolation with PostgreSQL Row-Level Security

- Status: Accepted
- Date: 2026-09-29

## Context

Each company's books must be invisible to every other company, including when application code
has a bug (a missing `WHERE company_id = …`). Accountants belong to many companies.

## Decision

- Every tenant-scoped table has `company_id` and RLS policies based on
  `app_current_company_id()` / `app_current_user_id()`. These read the transaction-local settings
  `app.company_id` / `app.user_id`.
- The API connects as **`acct_app`**: a login role with `NOBYPASSRLS` that owns no tables. The
  schema owner runs migrations only.
- All tenant queries run inside `withTenant(db, ctx, fn)`. It opens a transaction and calls
  `set_config(..., true)`, so the context can never leak to the next request on a pooled
  connection (tested).
- Identity tables (`users`, `sessions`, `mfa_recovery_codes`) are global and not RLS-scoped. The
  API reads them only in these ways:
  - by the authenticated user's id;
  - by email at sign-in;
  - by hashed token;
  - joined to RLS-filtered rows (member lists, audit actors).
- There is one exception for invitations: accepting one happens before the invitee is a member.
  `app_find_invitation(token_hash)` is a narrow `SECURITY DEFINER` function that returns only the
  row matching the hash.
- `companies` has no DELETE policy, so the app role cannot delete a company.
- Defense in depth: `CompanyAccessGuard` checks membership and permissions in the API before any
  query. RLS is the backstop.

## Consequences

- New tables need policies in the same migration, plus an isolation test.
- Reporting across companies (e.g. an accountant dashboard) must go through a deliberate, reviewed
  path.
