# Security controls (living document)

This maps implemented controls to the frameworks the product must meet:

- FTC GLBA Safeguards Rule
- IRS Publication 4557
- IRS Publication 1345 (once an e-file provider)
- SOC 2 Type II

The ASVS Level 2 review is in [asvs-l2.md](asvs-l2.md), the threat model in
[threat-model.md](threat-model.md), and the written policies in [../policies/](../policies/README.md).

| Area                  | Control                                                                                          | Where                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Access control        | Mandatory MFA (TOTP) for all users; recovery codes (120-bit, renewable)                          | ADR 0005, `apps/api/src/auth`                            |
| Access control        | Role-based permissions; least privilege roles                                                    | ADR 0006, `packages/shared/src/permissions.ts`           |
| Access control        | Fresh MFA code (5 minutes) for sensitive actions                                                 | ADR 0029, `auth/recent-mfa.guard.ts`                     |
| Access control        | Tenant isolation enforced by the database (RLS)                                                  | ADR 0003, `packages/db/migrations/0001_foundation.sql`   |
| Authentication        | argon2id with a pepper, breached-password check, separate password and MFA lockouts, rate limits | ADR 0029, `auth.service.ts`, `breach-check.ts`           |
| Authentication        | Emails on password, MFA, recovery code, new device and lockout events                            | `auth/security-notices.service.ts`                       |
| Sessions              | `__Host-` HttpOnly cookies, 30-minute idle and 12-hour limits, list and revoke, Clear-Site-Data  | `session.service.ts`, Settings > Security                |
| Web                   | CSRF header + Origin check; nonce CSP; HSTS; no-store; X-Frame-Options DENY                      | `common/security.middleware.ts`, `apps/web/src/proxy.ts` |
| Encryption at rest    | AES-256-GCM field and file encryption with AAD; data keys wrapped by AWS KMS; rotation           | ADR 0004, ADR 0029, `security/`, `packages/crypto`       |
| Encryption in transit | TLS everywhere; production refuses plain connections to Postgres and endpoints                   | `config.ts`                                              |
| Files                 | Type from bytes, virus scan, zip bomb caps, safe extensions, served as attachments               | ADR 0012, `documents/`                                   |
| Audit                 | Append-only audit log for all changes and sensitive reads; IP and request id                     | `apps/api/src/audit`                                     |
| Logging               | Redacted JSON logs and traces; security events (denials, unknown sign-ins, rejected input)       | ADR 0027, `observability/`                               |
| Retention             | Document purge, credential cleanup, change-request secrets dropped, exports deleted after 7 days | ADR 0029, migration 0033                                 |
| Data portability      | Owners export all company data (CSV, JSON, files)                                                | ADR 0029, `data-export/`                                 |
| Change management     | CI gates (lint, types, tests, e2e); migrations immutable once applied                            | `.github/workflows/ci.yml`, migrator                     |
| Supply chain          | CodeQL, dependency audit, gitleaks, Dependabot; actions pinned to commits                        | `.github/workflows/security.yml`                         |

## Infrastructure (12d, ADR 0030)

- Secrets in AWS Secrets Manager, generated write-only; task roles instead of keys; KMS key
  policies per key (`infra/terraform/modules/platform`).
- Logs in CloudWatch with alarms on errors and security events; CloudTrail, GuardDuty and
  Access Analyzer (`docs/runbooks/`).
- Point-in-time recovery replicated to a second region, locked copies in a backup account,
  and a scripted, verified restore drill (`infra/drill/restore-drill.sh`).

## Before launch

The launch checklist (`docs/launch-checklist.md`), including:

- a penetration test of staging;
- the first restore drill;
- the policies' placeholders filled in and approved (`docs/policies/README.md`).
