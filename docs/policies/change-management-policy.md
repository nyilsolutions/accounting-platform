# Change Management Policy

- **Owner:** [Security Officer]
- **Approved by:** [Approver]
- **Effective:** [Effective Date]
- **Next review:** [Review Date]
- **Version:** 1.0

## Purpose

This policy makes sure every change to the platform is authorized, reviewed, tested and
traceable, and that no single person can put an unreviewed change into production.

## Scope

- Application code, database migrations, tax data (`tax-data/`), CI workflows and dependencies in
  the source repository.
- Infrastructure (AWS resources, networking, IAM, KMS keys) and its configuration.
- Production configuration and secrets.
- These policies (they live in the repository and follow the same process).

## Policy

### 1. Pull requests

1. Every change must be made on a branch and merged through a pull request. Direct pushes to the
   main branch must be blocked by branch protection.
2. A pull request must describe what changes and why, and link the issue, ADR or open question
   it addresses. Changes that make a decision of lasting effect must add or update an ADR in
   `docs/adr/`.
3. Every pull request must be approved by at least one reviewer other than its author before it
   is merged. Approvals must be dismissed when new commits are pushed.
4. Changes in sensitive areas must also be reviewed for security, as set in the
   [Secure Development Policy](secure-development-policy.md) section 5.

### 2. Required checks

A pull request must not be merged unless these checks pass. They run in GitHub Actions
(`.github/workflows/ci.yml` and `security.yml`):

| Check                                 | What it proves                                                       |
| ------------------------------------- | -------------------------------------------------------------------- |
| Formatting, lint, typecheck           | Code meets the project's rules (for example, money is never a float) |
| Unit and integration tests            | Behavior is correct against a real Postgres with RLS enforced        |
| Performance at smoke scale            | Key reads and posting have not regressed                             |
| End-to-end tests (Playwright)         | The main user flows work in a browser                                |
| Desktop agent tests (.NET)            | The migration agent's core logic works                               |
| CodeQL (JavaScript/TypeScript and C#) | No new findings from static analysis (security-extended queries)     |
| Vulnerable dependencies               | `pnpm audit` and NuGet vulnerable-package checks pass                |
| Committed secrets (gitleaks)          | No credentials in any commit                                         |

1. Required checks must be enforced by branch protection, not by convention.
2. Workflows must run with read-only repository permissions by default and grant more only to
   the job that needs it. Third-party actions must be pinned to a full commit SHA. Both hold
   today.
3. A change that weakens a required check (removing a test, raising an audit threshold, adding a
   gitleaks ignore) must say so in the pull request and be approved by the [Security Officer].

### 3. Separation of duties

1. Authors must not approve their own pull requests.
2. Production deploys must be performed by the CI/CD pipeline from the main branch, not from a
   developer's machine.
3. People who can change branch protection or CI settings must be limited to repository
   administrators named by the [Engineering Lead], and every such change must be reviewed in the
   quarterly access review.
4. In a team too small for full separation, the [Security Officer] must review merged changes
   after the fact each week and record that review.

### 4. Database migrations

1. Migrations are plain SQL files, applied in order by the migrator as the database owner role.
2. Migrations are append-only. An applied migration must never be edited; the migrator stores a
   SHA-256 checksum of each one and refuses to run if a file has changed
   (`packages/db/src/migrator.ts`). Fixes are new migrations.
3. Every new tenant table must enable row-level security with its policies in the same
   migration, and come with a test proving isolation (ADR 0003).
4. Migrations must never grant the app role ownership, `BYPASSRLS`, or update or delete rights
   on the audit log.
5. Migrations must run before the code that depends on them is started, and must be compatible
   with the version of the code still running during a deploy.

### 5. Infrastructure as code

1. AWS infrastructure must be defined in code (Terraform), reviewed and merged like application
   code, and applied by the pipeline.
2. Changes made by hand in the AWS console must be limited to emergencies (section 6) and brought
   back into code within 5 business days. Drift detection should run at least weekly.
3. Plans must be reviewed before apply. Changes that touch IAM, KMS, networking, logging or
   backups count as sensitive and need security review.

### 6. Emergency changes

1. An emergency change is one needed to restore service or stop an active security incident.
2. It may be deployed with verbal approval from the [Engineering Lead] or the [Security Officer]
   and with the required checks that can run in the time available.
3. A pull request with full review and all checks must follow within 2 business days, and the
   change must be recorded in the incident or change log.

### 7. Releases and rollback

1. Each release must be traceable to the commits it contains.
2. Every release must have a rollback path. Because migrations are append-only, rollback means
   deploying the previous code (which must still work with the new schema) or a forward fix.

### 8. Dependency changes

1. Dependency updates come as pull requests (Dependabot weekly, and at once for security
   advisories; `.github/dependabot.yml`) and follow this policy like any other change.
2. The lockfile must be committed and CI must install with `--frozen-lockfile`.

## Roles and responsibilities

| Role               | Responsibilities                                                         |
| ------------------ | ------------------------------------------------------------------------ |
| Authors            | Write the change, its tests and its description; respond to review       |
| Reviewers          | Check correctness, security and tests; approve only what they understand |
| [Engineering Lead] | Owns the pipeline and branch protection; approves emergency changes      |
| [Security Officer] | Approves changes to security checks; reviews after the fact where needed |

## Exceptions

Exceptions must be documented, approved by the [Security Officer], and time-limited. An emergency
change under section 6 is not an exception, but its follow-up is mandatory.

## Enforcement

Bypassing review or required checks may lead to removal of merge or deploy rights and
disciplinary action.

## Related documents

- [Secure Development Policy](secure-development-policy.md)
- [Incident Response Plan](incident-response-plan.md)
- [ADR 0002: Kysely and SQL migrations](../adr/0002-kysely-and-sql-migrations.md)
- [ADR 0003: Tenant isolation](../adr/0003-tenant-isolation-rls.md)
- [CI workflow](../../.github/workflows/ci.yml)
- [Security workflow](../../.github/workflows/security.yml)

## Revision history

| Version | Date             | Change          | Approved by |
| ------- | ---------------- | --------------- | ----------- |
| 1.0     | [Effective Date] | Initial version | [Approver]  |
