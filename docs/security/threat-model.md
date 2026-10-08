# Threat model (Phase 12c)

What we protect, from whom, where the trust boundaries are, and what stops each threat. It is
written per trust boundary with STRIDE (spoofing, tampering, repudiation, information
disclosure, denial of service, elevation of privilege). Update it with any ADR that adds a
boundary, a data store or a third party (`docs/policies/secure-development-policy.md`).

## What we protect

| Asset                                                     | Why it matters                                          | Class          |
| --------------------------------------------------------- | ------------------------------------------------------- | -------------- |
| SSNs, EINs, TINs, bank and card numbers                   | Identity theft, payroll and tax fraud (GLBA, Pub 4557)  | Restricted     |
| Credentials: passwords, MFA secrets, sessions, API tokens | Account takeover, access to everything below            | Restricted     |
| Field keys and the KMS key                                | Decrypt every Restricted value                          | Restricted     |
| Each company's books, payroll and documents               | Confidential business and personal data                 | Confidential   |
| Money movement: payroll deposits, tax payments, pay links | Direct financial loss                                   | Confidential   |
| The audit log                                             | Proof of who did what (accountants, auditors, disputes) | Confidential   |
| Availability at month end, payroll and tax deadlines      | Late payroll and penalties                              | (availability) |

## Who might attack

- **Outsiders** on the internet: credential stuffing, phishing, scanning for web flaws.
- **A member of one company** reaching into another company (multi-tenant isolation), or past
  their role inside their own (a clerk paying themselves).
- **Employees, contractors and customers** using the portals, who see only their own records.
- **A stolen session or an unlocked browser** of a legitimate user.
- **Malicious files**: uploads, emailed receipts, bank statements and QuickBooks files.
- **A compromised third party or dependency**: an npm package, a provider's API, a CI action.
- **An insider with infrastructure access** (database, logs, backups).

## Trust boundaries and data flows

```
Browser ──HTTPS──> ALB ──> Web (Next.js) ──/api proxy──> API (NestJS) ──TLS──> Postgres (RLS)
   │                                                        │  │  │
   │ portals, pay page (public routes)                      │  │  └──> S3 (encrypted files) / KMS
   │                                                        │  └─────> clamd (sidecar, local)
Desktop agent ──HTTPS + agent key──> API                     └────────> Plaid, Stripe, Intuit, IRS,
Mail provider ──signed webhook──> API (email-in)                         Anthropic, HIBP, ECB
Stripe / Plaid ──signed webhooks──> API          Worker (same code, jobs from Postgres)
```

1. **Internet to web and API:** everything a browser sends is untrusted.
2. **API to Postgres:** the API connects as `acct_app`, which owns nothing and is subject to RLS.
3. **API to third parties:** their answers are untrusted input; their webhooks are signed.
4. **Files into the system:** every byte from people or providers is untrusted until detected,
   scanned and, for text, parsed by code that can't run it.
5. **People with infrastructure access:** encrypted columns and files stay unreadable without
   KMS.

## Threats and mitigations

### 1. Internet to web and API

| STRIDE | Threat                                   | Mitigation                                                                                                                 |
| ------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| S      | Credential stuffing, password guessing   | MFA for everyone; breached passwords refused; lockout per account (separate for codes); per-IP limits                      |
| S      | Phishing for a TOTP code                 | Codes used once; a reused one is refused, audited and emailed; new-device emails                                           |
| S      | Stolen session                           | `__Host-` HttpOnly cookie; 30-minute idle, 12-hour limit; fresh MFA for sensitive actions; sessions listable and revocable |
| T      | CSRF                                     | Custom header plus Origin check on every state change                                                                      |
| T      | XSS leading to actions as the user       | React escaping; nonce CSP with `strict-dynamic`; no inline script; files never rendered as pages                           |
| R      | "I didn't do that"                       | Append-only audit log of every change and sensitive read, with IP and request id                                           |
| I      | Account enumeration                      | Generic sign-in errors and timing; registration still tells (question 90)                                                  |
| I      | Caching of pages and API answers         | `no-store` everywhere; `Clear-Site-Data` on sign-out                                                                       |
| D      | Large or compressed bodies, slow regexes | Size limits per route; compressed bodies refused; linear parsers; zip bomb caps                                            |
| E      | Open redirect into a phishing page       | `safeRedirectPath`                                                                                                         |

### 2. Tenant and role isolation

| STRIDE | Threat                                        | Mitigation                                                                                           |
| ------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| E      | Reading or changing another company's records | RLS on every tenant table, set per transaction by `withTenant`; non-members get 404; RLS tests       |
| E      | A role doing more than it should              | `RequirePermission` on every company route; the web hides what the API refuses anyway                |
| E      | A clerk paying themselves                     | Direct deposit changes need payroll access and a fresh MFA code; employees' own changes are approved |
| E      | Removed members keeping access                | Sessions are per user; agent keys stop when their creator loses `migration.manage`                   |
| E      | Portal users reaching company routes          | Portal users aren't members; portal routes take the record from the link, never the request          |
| T      | Changing closed books                         | Closing date guarded in `PostingService`; password with an attempt limit; every change audited       |
| T      | Paying the same tax twice by racing           | Per-company lock on liability payments; database checks on statuses                                  |

### 3. Third parties and webhooks

| STRIDE | Threat                                       | Mitigation                                                                                  |
| ------ | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| S      | Forged Stripe, Plaid or email-in webhooks    | Signatures checked over the exact bytes; events recorded once (`payment_events`)            |
| T      | A provider's link pointing at internal hosts | QuickBooks download links must be its file hosts over https; no redirects; size caps (SSRF) |
| I      | Our data leaking through a provider          | Requests carry only what each needs (no SSNs to the tax engine; ids only in jobs)           |
| D      | A provider down at payroll time              | Interfaces with clear "sending/unknown" states; retries through jobs; nothing guessed       |

### 4. Files

| STRIDE | Threat                                          | Mitigation                                                                          |
| ------ | ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| T      | Malware uploaded and shared                     | Type from the bytes; virus scan before use; HTML, SVG and executables refused       |
| E      | A file run in the browser or on a desktop       | Served with `nosniff`, a sandbox CSP, as attachments; extension must match the type |
| D      | Zip bombs, huge statements, crafted OFX or IIF  | Entry and size caps; linear scans; length limits                                    |
| T      | Spreadsheet formulas in exports                 | `safeCell` on every CSV                                                             |
| E      | A parser bug exploited by a crafted PDF or MIME | Maintained libraries, kept current by Dependabot; own process later (question 95)   |

### 5. Data at rest and infrastructure

| STRIDE | Threat                                   | Mitigation                                                                                                                              |
| ------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| I      | A database dump or backup stolen         | Restricted columns encrypted with keys wrapped by KMS, bound to their row (AAD); files encrypted by S3 with our KMS key                 |
| I      | Sensitive values in logs or traces       | Redacting logger and trace exporter; values never passed to logs; audit records redacted                                                |
| T      | Tampering with the audit log             | `acct_app` can only insert and read; triggers refuse updates, deletes and truncation                                                    |
| I      | Old credentials and secrets lying around | Sessions, links and invitations deleted 30 days after they end; decided change requests drop bank numbers; exports deleted after 7 days |
| E      | A compromised CI action or dependency    | Actions pinned to commits with read-only tokens; lockfile; audit, CodeQL, gitleaks, Dependabot                                          |
| D      | Losing the database or a region          | Point-in-time recovery replicated to a second region, locked copies in a backup account, quarterly restore drills (ADR 0030)            |

## Residual risks

Accepted for now, each with an open question:

- Registration tells whether an email has an account (90).
- File parsers share the API and worker processes (95).
- No storage quota per company, and email-in has no daily cap (91).
- The Desktop agent is unsigned (94); there is no SBOM per release (92).
- A company or person can't yet delete their account themselves (93).
- Traces aren't collected yet; logs and alarms are in CloudWatch (84).
- The recovery region holds data, not a running copy: a region loss takes hours (107).
