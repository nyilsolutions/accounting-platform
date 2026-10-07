# OWASP ASVS 4.0.3 Level 2: review and checklist (Phase 12c)

The owner chose ASVS Level 2 as the verification standard (2026-10-07, ADR 0029). This page is
the result of the 12c review: every chapter was read against the code by three independent
reviews (authentication, sessions and access; input, files, API and configuration;
architecture, cryptography, errors, data and business logic), each finding was verified by
hand before it was fixed, and each fix has a test.

Status: **Met** (with where), **Partial** (what is left, with its open question), **12d** (an
infrastructure control that arrives with the AWS launch), or **N/A** (with why).

Re-run this review before each major release and whenever a chapter's code changes a lot
(`docs/policies/secure-development-policy.md`).

## Summary

| Chapter                               | Not yet met (question)                                         | Fixed in 12c                                                         |
| ------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| V1 Architecture and threat modeling   | Component isolation (12d); unsigned Desktop agent (94)         | Threat model written (`threat-model.md`)                             |
| V2 Authentication                     | Registration reveals existing emails (90)                      | MFA lockout, TOTP replay, breach check, pepper, recovery codes, more |
| V3 Session management                 |                                                                | 30-minute idle, list and revoke sessions, re-authentication          |
| V4 Access control                     |                                                                | Step-up for sensitive actions, agent keys, portal scoping            |
| V5 Validation, sanitization, encoding |                                                                | Redirects, CSV formulas, ReDoS, SSRF, NUL characters                 |
| V6 Stored cryptography                |                                                                | KMS envelope keys, rotation, GCM tag length                          |
| V7 Errors and logging                 | Log retention and alarms (12d, 84)                             | Security events, generic errors, crash handlers                      |
| V8 Data protection                    | Deleting a company or account (93)                             | no-store, Clear-Site-Data, retention, data export                    |
| V9 Communications                     | The load balancer's TLS policy (12d)                           | TLS required to every service in production                          |
| V10 Malicious code                    | Signed agent (94), SBOM (92)                                   | CI scanning, pinned actions                                          |
| V11 Business logic                    |                                                                | Payment race, closing password, checkout limits                      |
| V12 Files and resources               | Storage quota per company (91)                                 | Zip bombs, safe extensions, gzip bodies, download caps               |
| V13 API                               |                                                                | 415 for body types nothing reads                                     |
| V14 Configuration                     | Builds and deployment (12d); parsers in their own process (95) | CSP and HSTS, production checks, Content-Disposition                 |

## V1 Architecture, design and threat modeling

| Req     | Control                                      | Status  | Where                                                                                           |
| ------- | -------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| 1.1.2   | Threat model for the design and its changes  | Met     | `threat-model.md`; ADRs per feature                                                             |
| 1.1.4   | Trust boundaries and data flows documented   | Met     | `threat-model.md`                                                                               |
| 1.1.6   | Central, vetted security controls            | Met     | Guards (`SessionGuard`, `CompanyAccessGuard`, `RecentMfaGuard`), `withTenant`, `FieldEncryptor` |
| 1.2.1   | Unique, least-privilege service accounts     | Met     | `acct_app` owns nothing, no BYPASSRLS (ADR 0003); migrations as the owner role                  |
| 1.4.1   | Access control enforced at a trusted layer   | Met     | API guards and Postgres RLS; the web only hides what the API refuses                            |
| 1.4.4   | One access control mechanism                 | Met     | `RequirePermission` over `ROLE_PERMISSIONS` (ADR 0006)                                          |
| 1.5.x   | Input and output architecture                | Met     | zod schemas shared by API and web (rule 8); parsers are pure and shared                         |
| 1.6.1-4 | Key management policy, keys in a vault       | Met     | ADR 0029: AWS KMS wraps data keys; `docs/policies/encryption-and-key-management-policy.md`      |
| 1.7.1   | Common logging format                        | Met     | `JsonLogger` with request, user, job and trace ids (ADR 0027)                                   |
| 1.14.1  | Segregation of components of differing trust | 12d     | API, worker, web and Postgres in separate tasks and subnets; parsers in the API process (below) |
| 1.14.6  | No unsupported client technologies           | Partial | Desktop migration agent ships unsigned until a code-signing certificate exists (question 94)    |

## V2 Authentication

| Req                   | Control                                                     | Status  | Where                                                                                           |
| --------------------- | ----------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| 2.1.1-4               | At least 12 characters, up to 128, any characters           | Met     | `PASSWORD_MIN_LENGTH`/`PASSWORD_MAX_LENGTH` in `packages/shared/src/auth.ts`                    |
| 2.1.5, 2.1.6          | People can change their password (current one needed)       | Met     | **12c:** `POST /auth/password`, signs out other sessions, emails the person                     |
| 2.1.7                 | Breached passwords refused                                  | Met     | **12c:** `HibpBreachChecker` (k-anonymity, padded); required in production                      |
| 2.1.8                 | Strength meter                                              | Met     | **12c:** `PasswordInput` with `passwordStrength`                                                |
| 2.1.9                 | No composition rules                                        | Met     | Length only                                                                                     |
| 2.1.11, 12            | Paste allowed; show password                                | Met     | **12c:** Show/Hide on every password field                                                      |
| 2.2.1                 | Anti-automation: lockout and rate limits                    | Met     | **12c:** separate, atomic password and MFA counters; 10 failures lock 15 minutes; per-IP limits |
| 2.2.3                 | Notify after credential changes                             | Met     | **12c:** `SecurityNoticesService` (password, MFA, recovery code, new device, lockout)           |
| 2.2.2, 2.3.x          | Out-of-band and initial secrets                             | N/A     | No SMS or email codes; invitations are single-use, expiring links                               |
| 2.4.1, 2.4.4          | Passwords hashed with argon2id                              | Met     | `packages/crypto/src/password.ts` (ADR 0005)                                                    |
| 2.4.5                 | Additional secret (pepper)                                  | Met     | **12c:** `PASSWORD_PEPPER`, required in production; older hashes re-made at sign-in             |
| 2.5.1-4               | Recovery without revealing the password; no shared accounts | Met     | Recovery codes; no password hints or questions                                                  |
| 2.5.5                 | Notify when an authentication factor changes                | Met     | **12c:** emails on MFA enable and recovery code use or renewal                                  |
| 2.6.1-3               | Look-up secrets single-use, enough entropy                  | Met     | **12c:** 120-bit recovery codes, used once, can be renewed                                      |
| 2.7.x                 | Out-of-band verifiers                                       | N/A     | None used                                                                                       |
| 2.8.1-4               | TOTP: time window, used once                                | Met     | **12c:** last used step claimed atomically; a replay is refused                                 |
| 2.8.5                 | Replayed codes logged and reported                          | Met     | **12c:** `auth.totp_replayed` audit row and an email                                            |
| 2.8.6                 | Lost device: re-issue                                       | Met     | Recovery code, then set MFA up again                                                            |
| 2.9.x                 | Cryptographic verifiers (WebAuthn)                          | N/A     | Not required at L2; question 89                                                                 |
| 2.10.1-4              | Service credentials not hard-coded; stored securely         | Met     | Config from the environment; Desktop agent keys stored as hashes                                |
| (account enumeration) | Same answer for unknown accounts                            | Partial | Sign-in is generic; registering an existing email says so (question 90)                         |

## V3 Session management

| Req     | Control                                           | Status | Where                                                                                                |
| ------- | ------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| 3.1.1   | Tokens never in URLs                              | Met    | Cookie only; one-time links are exchanged for a cookie                                               |
| 3.2.1-3 | New token at sign-in; 128+ bits; stored as a hash | Met    | `session.service.ts`; rotated after MFA                                                              |
| 3.3.1   | Sign-out ends the session on the server           | Met    | `POST /auth/logout`; **12c:** `Clear-Site-Data`                                                      |
| 3.3.2   | Idle 30 minutes, absolute 12 hours                | Met    | **12c:** defaults and production limits in `config.ts`                                               |
| 3.3.3   | Other sessions end after a password change        | Met    | **12c:** `changePassword`                                                                            |
| 3.3.4   | People see and end their sessions                 | Met    | **12c:** Settings > Security; `GET/DELETE /auth/sessions`                                            |
| 3.4.1-5 | Secure, HttpOnly, SameSite, `__Host-`, path       | Met    | `__Host-acct_session`, `SameSite=Lax`, `Secure` required in production                               |
| 3.5.x   | Token-based (stateless) sessions                  | N/A    | Sessions are server-side                                                                             |
| 3.7.1   | Re-authentication before sensitive actions        | Met    | **12c:** `RequireRecentMfa` (5 minutes) on SSN/EIN reveal, direct deposit, members, payments, export |

## V4 Access control

| Req     | Control                                       | Status | Where                                                                                        |
| ------- | --------------------------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| 4.1.1-3 | Enforced on the server; least privilege       | Met    | `CompanyAccessGuard` + `@RequirePermission`; RLS (ADR 0003, 0006)                            |
| 4.1.3   | Access ends when membership changes           | Met    | **12c:** Desktop agent keys stop working when their creator loses `migration.manage`         |
| 4.1.5   | Fails closed                                  | Met    | Routes need a session and MFA by default (rule 9); non-members get 404                       |
| 4.2.1   | IDOR: records scoped to the company and owner | Met    | `withTenant`; portal routes take the person from the link, never the request (ADR 0023)      |
| 4.2.1   | Portal lists scoped by permission             | Met    | **12c:** employee links need payroll access, contractor links purchases access               |
| 4.2.2   | CSRF                                          | Met    | `x-csrf-protection` header and Origin check (`security.middleware.ts`)                       |
| 4.3.1   | Admin interfaces need MFA                     | Met    | Every route needs MFA                                                                        |
| 4.3.3   | Step-up for high-value actions                | Met    | **12c:** as 3.7.1; customer portal ends when the customer is inactive or their email changes |

## V5 Validation, sanitization and encoding

| Req     | Control                              | Status | Where                                                                                        |
| ------- | ------------------------------------ | ------ | -------------------------------------------------------------------------------------------- |
| 5.1.1-4 | Allow-list validation of every input | Met    | zod schemas through `ZodPipe`; unknown keys dropped                                          |
| 5.1.5   | Redirects only to allowed places     | Met    | **12c:** `safeRedirectPath` (no `//`, `/\`, control characters)                              |
| 5.2.1-2 | Untrusted HTML and text              | Met    | React escapes; no `dangerouslySetInnerHTML`; **12c:** NUL characters refused with a 400      |
| 5.2.4   | No eval                              | Met    | None; CSP without `unsafe-eval` in production                                                |
| 5.2.6   | SSRF                                 | Met    | **12c:** QuickBooks download links must be QuickBooks' file hosts over https, no redirects   |
| 5.3.1   | Output encoding for the context      | Met    | **12c:** CSV cells neutralize formulas (`safeCell`) in reports, wage CSV and the data export |
| 5.3.3-5 | XSS, SQL injection                   | Met    | React; Kysely parameters; custom report columns map to fixed SQL (ADR 0014)                  |
| 5.3.8   | OS command injection                 | Met    | No shell commands                                                                            |
| 5.3.x   | ReDoS (catastrophic regexes)         | Met    | **12c:** OFX blocks scanned linearly (22 s to under 1 s); IIF address regex length-capped    |
| 5.4.x   | Memory-safe code                     | N/A    | TypeScript and C#                                                                            |
| 5.5.1-3 | Deserialization                      | Met    | JSON only; **12c:** body types other than JSON, raw files and MIME refused with 415          |
| 5.5.2   | XML external entities                | N/A    | No XML parsing of untrusted input (QuickBooks Desktop data comes through the agent as JSON)  |

## V6 Stored cryptography

| Req        | Control                                     | Status | Where                                                                                                                        |
| ---------- | ------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 6.1.1-3    | Regulated data encrypted at rest            | Met    | SSNs, EINs, TINs, bank numbers, MFA secrets, tokens (`ENCRYPTED_COLUMNS`); files with SSE-KMS on S3 (required in production) |
| 6.2.1      | Failures are not silent; vetted algorithms  | Met    | AES-256-GCM with AAD; **12c:** 16-byte tag length enforced                                                                   |
| 6.2.2-6    | Approved algorithms, random IVs, no reuse   | Met    | Node `crypto`, random 96-bit IVs                                                                                             |
| 6.3.1-2    | Random values from a CSPRNG                 | Met    | `randomBytes`, `randomUUID`                                                                                                  |
| 6.4.1      | Keys in a key management solution           | Met    | **12c:** AWS KMS envelope encryption; data keys wrapped with EncryptionContext (ADR 0029)                                    |
| 6.4.2      | Key material not exposed to the app's users | Met    | **12c:** keys unwrapped at start-up only; `keys:rotate` and `keys:reencrypt`; the public example key is refused              |
| (rotation) | Keys can be rotated without downtime        | Met    | **12c:** versioned keyring; every value names its key version                                                                |

## V7 Error handling and logging

| Req        | Control                                    | Status  | Where                                                                                      |
| ---------- | ------------------------------------------ | ------- | ------------------------------------------------------------------------------------------ |
| 7.1.1-2    | No credentials or sensitive data in logs   | Met     | Redacting `JsonLogger` and trace exporter (ADR 0027); audit records redacted               |
| 7.1.3-4    | Security events logged with context        | Met     | **12c:** `securityEvent` for refused access, unknown-account sign-ins, rejected input      |
| 7.2.1-2    | Authentication and access decisions logged | Met     | Audit rows for sign-in, lockout, MFA; **12c:** guard denials                               |
| 7.3.1-4    | Logs protected; time-synchronized          | 12d     | JSON on stdout to CloudWatch; retention and access in 12d (question 84)                    |
| 7.3.3      | Audit log can't be changed                 | Met     | Triggers forbid update, delete and truncate on `audit_log`                                 |
| 7.4.1      | Generic errors to people                   | Met     | **12c:** database and network errors in migrations and the QuickBooks callback are generic |
| 7.4.2      | Exceptions handled everywhere              | Met     | `PgErrorFilter`; **12c:** the QuickBooks pull chain can't reject unhandled                 |
| 7.4.3      | A last-resort handler                      | Met     | **12c:** `installProcessHandlers` in the API and worker                                    |
| (alerting) | Anomalies raise alerts                     | Partial | Security events are logged and tagged; alarms are 12d (question 84)                        |

## V8 Data protection

| Req   | Control                                   | Status  | Where                                                                                                                                                                                 |
| ----- | ----------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8.1.1 | Sensitive responses not cached by servers | Met     | **12c:** `Cache-Control: no-store` on every API response and page                                                                                                                     |
| 8.1.2 | Cached copies on the server protected     | Met     | No server-side caches of tenant data                                                                                                                                                  |
| 8.2.1 | Browsers keep nothing sensitive           | Met     | **12c:** no-store; nothing sensitive in local storage                                                                                                                                 |
| 8.2.3 | Session data cleared at sign-out          | Met     | **12c:** `Clear-Site-Data: "cache", "cookies"`                                                                                                                                        |
| 8.3.1 | Sensitive data in the body, never URLs    | Met     | Reveals and exports are POSTs; one-time links exchanged at once                                                                                                                       |
| 8.3.2 | People can export and delete their data   | Partial | **12c:** owners export everything (CSV, JSON, files); deleting a company or account is question 93                                                                                    |
| 8.3.4 | Sensitive data identified, with a policy  | Met     | `docs/policies/data-classification-and-retention-policy.md`                                                                                                                           |
| 8.3.7 | Sensitive data encrypted                  | Met     | V6                                                                                                                                                                                    |
| 8.3.8 | Kept only as long as needed               | Met     | **12c:** purge also clears extraction results and the search index; credentials cleaned after 30 days; change-request bank numbers dropped when decided; exports deleted after 7 days |

## V9 Communications

| Req     | Control                           | Status | Where                                                                                                                 |
| ------- | --------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| 9.1.1-3 | TLS 1.2+ for clients              | 12d    | The ALB's TLS policy; HSTS on pages (**12c**)                                                                         |
| 9.2.1   | Trusted certificates to back ends | Met    | Node's CA store; no certificate checks turned off                                                                     |
| 9.2.2   | TLS to every back end             | Met    | **12c:** production refuses to start without `sslmode=verify-full` to Postgres, https endpoints, clamd beside the API |

## V10 Malicious code

| Req    | Control                                 | Status  | Where                                                                                          |
| ------ | --------------------------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| 10.1.1 | Code analysis                           | Met     | **12c:** CodeQL (security-extended) for TypeScript and C#                                      |
| 10.2.x | No back doors, time bombs or phone-home | Met     | Reviewed; outbound calls only to the providers in the vendor list                              |
| 10.3.2 | Integrity of the code and dependencies  | Met     | **12c:** lockfile, `pnpm audit`, NuGet checks, gitleaks, Dependabot, actions pinned to commits |
| 10.3.x | Signed releases of client software      | Partial | The Desktop agent is unsigned (question 94); an SBOM per release is question 92                |

## V11 Business logic

| Req      | Control                                        | Status | Where                                                                                                 |
| -------- | ---------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| 11.1.1-2 | Steps in order; realistic times                | Met    | Status machines with database checks (pay runs, filings, payments)                                    |
| 11.1.3   | Limits per user and per action                 | Met    | **12c:** 10 checkouts an hour per pay link; one customer portal link a minute                         |
| 11.1.4   | Anti-automation for expensive or risky actions | Met    | **12c:** closing date password locks after 5 wrong tries in 15 minutes, each one audited              |
| 11.1.6   | No race conditions in money movement           | Met    | **12c:** liability payments take a per-company lock; invoices, deposits and payroll already lock rows |

## V12 Files and resources

| Req      | Control                                     | Status  | Where                                                                                                     |
| -------- | ------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| 12.1.1   | Size limits                                 | Met     | Upload and body limits; **12c:** compressed bodies refused so they can't inflate past them                |
| 12.1.2   | Compressed files checked before extraction  | Met     | **12c:** Office text extraction caps entries (50) and inflated size (20 MB)                               |
| 12.1.3   | Quotas per user                             | Partial | Upload size per file only; a storage quota per company is question 91                                     |
| 12.2.1   | Type checked from the bytes                 | Met     | `detectFileType` (ADR 0012)                                                                               |
| 12.3.x   | No file paths from users                    | Met     | Storage keys are generated ids                                                                            |
| 12.4.1-2 | Files outside the web root; scanned         | Met     | `ObjectStore`; `VirusScanner` before a file can be used                                                   |
| 12.5.1   | Only expected extensions served             | Met     | **12c:** `withSafeExtension` at download (`Invoice.hta` is saved as `Invoice.hta.txt`)                    |
| 12.5.2   | Files never run in the browser              | Met     | `nosniff`, `sandbox` CSP on files, attachment for anything not previewable; **12c:** text served as UTF-8 |
| 12.6.1   | Server-side requests to allowed places only | Met     | **12c:** QuickBooks attachment hosts; other providers are fixed URLs                                      |

## V13 API and web service

| Req    | Control                   | Status | Where                                                                   |
| ------ | ------------------------- | ------ | ----------------------------------------------------------------------- |
| 13.1.1 | One encoding and parser   | Met    | JSON (UTF-8)                                                            |
| 13.1.3 | No sensitive data in URLs | Met    | V8.3.1                                                                  |
| 13.1.5 | Content type checked      | Met    | **12c:** 415 for any other body type and for compressed bodies          |
| 13.2.x | REST methods and schemas  | Met    | Nest routes with zod; state changes are POST/PUT/PATCH/DELETE with CSRF |
| 13.2.3 | CSRF on REST              | Met    | V4.2.2                                                                  |
| 13.3.x | SOAP                      | N/A    | None                                                                    |
| 13.4.x | GraphQL                   | N/A    | None                                                                    |

## V14 Configuration

| Req      | Control                                          | Status  | Where                                                                                           |
| -------- | ------------------------------------------------ | ------- | ----------------------------------------------------------------------------------------------- |
| 14.1.1-5 | Repeatable, hardened builds and deployment       | 12d     | Containers and Terraform                                                                        |
| 14.2.1-3 | Components up to date; vulnerable ones flagged   | Met     | **12c:** Dependabot and the dependency audit in CI                                              |
| 14.2.6   | Risky components isolated                        | Partial | PDF, ZIP and MIME parsers run in the API and worker processes (question 95)                     |
| 14.3.2-3 | No debug output or version headers in production | Met     | `x-powered-by` off; generic errors                                                              |
| 14.4.1   | Content type and charset on every response       | Met     | **12c:** text downloads say UTF-8                                                               |
| 14.4.2   | API responses are attachments                    | Met     | **12c:** `Content-Disposition: attachment` on JSON                                              |
| 14.4.3   | Content Security Policy                          | Met     | **12c:** a nonce CSP with `strict-dynamic` on every page (`apps/web/src/proxy.ts`)              |
| 14.4.4-7 | nosniff, Referrer-Policy, frame-ancestors        | Met     | helmet; `next.config.ts`; `frame-ancestors 'none'`                                              |
| 14.4.5   | HSTS                                             | Met     | **12c:** on pages outside development; helmet on the API                                        |
| 14.5.x   | Request headers and CORS                         | Met     | No CORS; Origin checked                                                                         |
| (config) | Unsafe production settings refused at start-up   | Met     | **12c:** TLS, https, clamd, JSON logs, KMS, pepper, breach check, the example key (`config.ts`) |
