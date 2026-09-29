# Security controls (living document)

This maps implemented controls to the frameworks the product must meet:

- FTC GLBA Safeguards Rule
- IRS Publication 4557
- IRS Publication 1345 (once an e-file provider)
- SOC 2 Type II

| Area                  | Control                                                                          | Where                                                      |
| --------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Access control        | Mandatory MFA (TOTP) for all users; recovery codes                               | ADR 0005, `apps/api/src/auth`                              |
| Access control        | Role-based permissions; least privilege roles                                    | ADR 0006, `packages/shared/src/permissions.ts`             |
| Access control        | Tenant isolation enforced by the database (RLS)                                  | ADR 0003, `packages/db/migrations/0001_foundation.sql`     |
| Authentication        | argon2id, lockout, per-IP rate limits, generic errors, timing equalization       | `apps/api/src/auth/auth.service.ts`                        |
| Sessions              | HttpOnly/SameSite/`__Host-` cookies, idle + absolute timeout, rotation after MFA | `session.service.ts`                                       |
| Web                   | CSRF header + Origin check; helmet headers; X-Frame-Options DENY                 | `common/security.middleware.ts`, `apps/web/next.config.ts` |
| Encryption at rest    | AES-256-GCM field encryption with AAD and key versions                           | ADR 0004, `packages/crypto`                                |
| Encryption in transit | TLS termination at the load balancer; `Secure` cookies required in production    | config validation                                          |
| Audit                 | Append-only audit log for all changes and sensitive reads; IP and request id     | `apps/api/src/audit`                                       |
| Logging               | No request bodies logged; sensitive keys redacted in audit records               | `audit.service.ts`                                         |
| Change management     | CI gates (lint, types, tests, e2e); migrations immutable once applied            | `.github/workflows/ci.yml`, migrator                       |

## To do before production

- KMS-backed keys, secrets manager, key rotation runbook
- Content-Security-Policy with nonces
- Centralized logging with PII redaction tests, alerting on auth anomalies
- Backups with point-in-time recovery and a tested restore; disaster-recovery drill
- Dependency and secret scanning in CI; penetration test
- Written information security program (GLBA), incident response plan, vendor management
