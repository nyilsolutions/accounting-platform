# Phase 0: Foundation

## Delivered

- **Monorepo** with pnpm and Turborepo:
  - `apps/api` (NestJS)
  - `apps/web` (Next.js)
  - `packages/{db,crypto,shared}`
  - CI on GitHub Actions: format, lint, typecheck, unit and integration tests on Postgres,
    Playwright end-to-end tests.
- **Accounts and sign-in:**
  - Registration and login.
  - **Mandatory TOTP two-step verification** with recovery codes, replay protection, account
    lockout and rate limits.
  - Session cookies with idle and absolute timeouts; the token rotates after MFA.
  - CSRF protection and security headers.
- **Companies (tenants):**
  - Create a company and edit its profile: legal/DBA name, EIN, address, fiscal year start, tax
    form, accounting method.
  - The EIN is **encrypted at rest**, displayed masked, and revealed only on request with an
    audit entry.
- **Multi-company:** accountants can belong to many companies, with a company list and a switcher.
- **Users and roles:** nine QuickBooks-style roles. Owners and admins can:
  - Invite by email (7-day single-use link, bound to the invited email).
  - Change roles or remove users.
  - Revoke pending invitations.
  - Owner-role protections apply (last owner cannot be removed; only owners manage owners).
- **Tenant isolation:** PostgreSQL Row-Level Security. The API uses a non-owner role, and
  transaction-local context is set per request.
- **Audit log:**
  - Append-only (DB trigger plus no UPDATE/DELETE grant).
  - Written in the same transaction as each change, with before/after diffs, actor, IP and
    request id.
  - Sensitive values are redacted.
  - Filterable, paginated UI.
- **App shell:**
  - Sidebar navigation filtered by permission.
  - Company switcher.
  - Command palette (`Ctrl/⌘+K`).
  - Shortcuts (`g d`, `g u`, `g l`, … and `?` for help).
  - Placeholder pages that name the phase delivering each module.
- **Demo seed:** "Sample Landscaping Co." with a demo owner.

## Demo script

1. `pnpm dev`, open http://localhost:3000, then click **Create an account**.
2. Scan the QR code, enter the 6-digit code, and save the recovery codes.
3. Create a company with an EIN. The dashboard shows `**-***6789`.
4. Press `g` then `u`. Invite `cpa@example.com` as Accountant; the link appears in the API console.
5. Press `g` then `c`. Edit the phone number and save. Click **Show full EIN**.
6. Press `Ctrl+K`, type "audit", press Enter. Every action above is listed with before/after
   values.
7. Open the invitation link in a private window, create the CPA account, and accept. The CPA sees
   the company as **Accountant** and cannot manage users.

## Tests

| Suite                   | Count | What it proves                                                                                                                                                                       |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared`       | 9     | Role/permission matrix, company validation, PATCH does not apply defaults                                                                                                            |
| `packages/crypto`       | 13    | RFC 6238 vectors, replay rejection, AES-GCM tamper/AAD/rotation, argon2id                                                                                                            |
| `packages/db`           | 9     | App role cannot bypass RLS; cross-tenant reads and writes blocked; audit log immutable; no context leak across pooled transactions                                                   |
| `apps/api`              | 22    | Full HTTP flows: MFA gating, replay, recovery codes, lockout, token rotation, CSRF, EIN encryption/redaction, permissions per role, owner protections, invitations, audit pagination |
| `apps/web` (Playwright) | 2     | Sign-up → MFA → company → shortcuts → invite → settings → audit log → CPA accepts → sign-out/in with MFA; protected-route redirect                                                   |

Screenshots from the end-to-end run are in `docs/screenshots/`.

## Known gaps (tracked for later phases)

- No real email provider yet. Production start-up is blocked until one is configured.
- No password reset or email verification yet. Password reset needs email plus an MFA-aware
  recovery flow.
- Field encryption uses an environment key. The KMS provider is pending (ADR 0004).
- Content-Security-Policy is not set yet, because Next.js needs nonce plumbing.
- No session-management UI (list/revoke sessions) and no MFA reset by an admin.
- Custom roles are not implemented; the nine fixed roles cover Phase 0.
