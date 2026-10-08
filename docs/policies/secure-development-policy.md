# Secure Development Policy

- **Owner:** [Security Officer]
- **Approved by:** [Approver]
- **Effective:** [Effective Date]
- **Next review:** [Review Date]
- **Version:** 1.0

## Purpose

This policy builds security into each step of how [Company] designs, writes, tests and ships the
platform, and sets the standard the platform is verified against.

## Scope

All code in the source repository: the API and job worker (`apps/api`), the web app
(`apps/web`), the QuickBooks Desktop migration agent (`apps/desktop-agent`), shared packages, tax
data, database migrations, CI workflows and infrastructure code. It applies to staff and
contractors who write or review that code.

## Policy

### 1. Verification standard

1. The platform must meet OWASP Application Security Verification Standard (ASVS) Level 2.
2. The ASVS review must be repeated at least once a year and before a major release. Findings
   must be tracked to closure with the remediation times in section 7.
3. Code comments and ADRs should cite the ASVS requirement a control meets (for example, the
   session limits in `apps/api/src/config.ts` cite ASVS 3.3.2).

### 2. Design and threat modeling

1. New features that handle Restricted data, add an external integration, add a public
   (unauthenticated) route, or change authentication, authorization or tenant isolation must have
   a threat model before build starts.
2. The threat model must name the assets, the trust boundaries, the threats (STRIDE or similar)
   and the controls, and be recorded in the feature's ADR or pull request.
3. Decisions with lasting security effect must be recorded as ADRs in `docs/adr/`.

### 3. Coding rules

The non-negotiable rules in the repository's root contributor guide are mandatory.
Security-relevant ones include:

1. Tenant data must go through `withTenant()` so row-level security applies, and every tenant
   table must have RLS policies and an isolation test (ADR 0003).
2. Every state change must write an audit row in the same transaction. Sensitive values must never
   be written to the audit log or logs.
3. Restricted values must be stored with field encryption using an AAD that binds them to their
   row (ADR 0004).
4. Routes require a session with completed MFA by default. Public or pending-MFA routes must be
   marked deliberately and reviewed. Company routes must check a permission.
5. State-changing requests must carry the CSRF header, and the Origin check must stay in place.
6. Validation schemas are shared by the API and the web and run on the server for every input.
7. Uploaded files are typed from their bytes, scanned for malware before use, and downloaded only
   through a permission-checked, short-lived link (ADR 0012).
8. External services must be reached through an interface with a test double; tests must never
   call the network.
9. Background work goes through the job queue, and job data carries ids only, never secrets or
   Restricted values (ADR 0027).
10. Custom report columns and filters map to fixed SQL expressions only; user input is never
    concatenated into SQL.

### 4. Automated scanning

These run on every pull request, on the main branch, and weekly (`.github/workflows/security.yml`):

| Scan                    | Tool                                                                                                        | Blocks merge             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------ |
| Static analysis         | CodeQL, security-extended queries, JS/TS and C#                                                             | Yes                      |
| Vulnerable dependencies | `pnpm audit` (any severity in production dependencies, high in development ones); NuGet vulnerable packages | Yes                      |
| Committed secrets       | gitleaks over every commit, the binary pinned and checksum-verified                                         | Yes                      |
| Dependency updates      | Dependabot (npm, GitHub Actions, NuGet), weekly and on advisories                                           | No (opens pull requests) |

1. Suppressing a finding (a CodeQL dismissal, an audit exception, a `.gitleaksignore` entry) must
   record the reason in the pull request and be approved by the [Security Officer].
2. A secret found in history must be treated as exposed: rotate it first, then remove it.
3. Container images, once built, must be scanned for vulnerabilities before deploy.

### 5. Security review of sensitive areas

A reviewer with security training must approve changes to:

- authentication, sessions, MFA, step-up and password handling (`apps/api/src/auth`);
- roles, permissions and `CompanyAccessGuard`;
- RLS policies, security-definer functions and database grants;
- field encryption, key handling and AAD construction (`packages/crypto`, `apps/api/src/security`);
- payroll payments, direct deposit, EFTPS, e-file and online payments;
- public routes, webhooks and portals;
- logging, redaction and tracing exporters;
- CI workflows, branch protection and infrastructure IAM or KMS.

### 6. Testing

1. Every feature must have tests. Data-access tests must use a real Postgres, not mocks.
2. Security controls must have tests that prove them: tenant isolation, permission denial (404 for
   non-members), step-up enforcement, redaction, and that the app role cannot change the schema.
3. A penetration test of the platform must be performed by a qualified independent tester at
   least once a year and before launch. Vulnerability assessments must run at least every six
   months.

### 7. Vulnerability remediation

Vulnerabilities from any source (scanners, pen tests, bug reports, advisories) must be fixed or
mitigated within:

| Severity (CVSS v3/v4) | Fix within                                      |
| --------------------- | ----------------------------------------------- |
| Critical (9.0–10.0)   | 7 days                                          |
| High (7.0–8.9)        | 30 days                                         |
| Medium (4.0–6.9)      | 90 days                                         |
| Low (below 4.0)       | Next planned release, or accepted with a reason |

A finding that is exploited or likely to be exploited is handled under the
[Incident Response Plan](incident-response-plan.md).

### 8. Supply chain

1. New dependencies must be justified in the pull request, be actively maintained, and come from
   the official registries.
2. Tools downloaded in CI must be pinned to a version and verified by checksum.
3. Released desktop agent builds must be code-signed before distribution to customers.

### 9. Environments and data

1. Production customer data must never be copied to development, test or CI environments.
   Use the seed data and the performance data generator.
2. Development keys and secrets must never be used in production. The API refuses to start in
   production with the public example encryption key (`apps/api/src/config.ts`).

### 10. Training

Developers must complete secure coding training at hire and every year, covering the OWASP Top 10
and this policy.

## Roles and responsibilities

| Role               | Responsibilities                                                                |
| ------------------ | ------------------------------------------------------------------------------- |
| [Security Officer] | Owns this policy and the ASVS review; approves suppressions; arranges pen tests |
| [Engineering Lead] | Makes sure the rules and scans are followed; assigns security reviewers         |
| Developers         | Follow the rules; write tests; threat-model sensitive features                  |

## Exceptions

Exceptions must be documented, approved by the [Security Officer], and time-limited. Accepted
vulnerability risk must be recorded in the risk register.

## Enforcement

Code that does not meet this policy must not be merged. Repeated violations may lead to removal of
merge rights and disciplinary action.

## Related documents

- [Change Management Policy](change-management-policy.md)
- [Encryption and Key Management Policy](encryption-and-key-management-policy.md)
- [Logging and Monitoring Policy](logging-and-monitoring-policy.md)
- [Security controls](../security/README.md)
- [ADR 0003](../adr/0003-tenant-isolation-rls.md), [ADR 0004](../adr/0004-field-encryption.md),
  [ADR 0012](../adr/0012-documents.md), [ADR 0027](../adr/0027-jobs-and-observability.md)

## Revision history

| Version | Date             | Change          | Approved by |
| ------- | ---------------- | --------------- | ----------- |
| 1.0     | [Effective Date] | Initial version | [Approver]  |
