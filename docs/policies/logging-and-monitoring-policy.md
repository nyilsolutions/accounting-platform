# Logging and Monitoring Policy

- **Owner:** [Security Officer]
- **Approved by:** [Approver]
- **Effective:** [Effective Date]
- **Next review:** [Review Date]
- **Version:** 1.0

## Purpose

This policy sets what [Company] records about activity on the platform, how those records are
protected, and how they are watched so that security events and outages are found quickly.

## Scope

- The product audit log (customer-visible record of changes and sensitive reads).
- Application logs and traces from the API and job workers.
- Infrastructure and cloud logs (AWS CloudTrail, load balancer, database, KMS, S3 access).
- Logs from GitHub, CI and the identity provider.

## Policy

### 1. The audit log

1. Every state change in the product must write an audit row in the same database transaction as
   the change, so a change cannot happen without its record.
2. Sensitive reads (revealing an SSN or EIN, downloading a data export, exporting full SSNs) must
   also be audited.
3. Each row records the company, the acting user, the action, the entity, before and after values
   (without sensitive values), the IP address, the user agent and the request id. Jobs record the
   job id as the request id.
4. The audit log is append-only. A database trigger rejects every update, delete and truncate,
   and the app role is granted only select and insert (migration `0001_foundation.sql`). The app
   role must never be granted more.
5. The audit log is tenant-scoped by row-level security: a company sees only its own entries.
6. Corrections are made by new records (for example, accountant reviews are kept in a separate
   table), never by editing an audit row.

### 2. Application logs and traces

1. Logs must be structured JSON, one object per line, in production; the API refuses another
   format in production (`apps/api/src/config.ts`, ADR 0027).
2. Every line carries the request id, the signed-in user's id (never a name or email), the job,
   and the trace and span ids when tracing is on.
3. Each request is logged once with method, path, status and duration. Query strings are dropped
   and token-like path segments are replaced.
4. Refused and suspicious requests must be logged as security events with ids and field paths
   only.
5. Traces leave the process only through the redacting exporter, which drops query strings,
   cookies and user agents and redacts strings and error messages. Database statements are
   recorded with placeholders, never values.

### 3. What must never be logged

1. Request or response bodies, headers and cookies.
2. Passwords, MFA codes, recovery codes, session and one-time tokens, API keys and secrets.
3. SSNs, EINs, TINs, bank account and routing numbers, and card numbers.
4. Full email addresses in application logs (the redactor keeps only the domain).

The logger redacts these patterns as a safety net (`apps/api/src/observability/redact.ts`).
Redaction is not permission: code must not pass such values to the logger. A sensitive value
found in any log is a security incident: the log must be purged and the cause fixed.

### 4. Infrastructure logging

1. AWS CloudTrail must be on for all regions and accounts, including data events for the S3
   buckets that hold documents and exports, and must write to a separate log archive account
   with object lock or equivalent write-once protection.
2. KMS key use, IAM changes, security group changes and console sign-ins must be logged.
3. Load balancer access logs, database logs (connections, errors, DDL) and VPC flow logs should
   be on.
4. GitHub audit logs and identity provider sign-in logs must be kept for the same period as
   application logs.

### 5. Protection and retention

1. Logs must be encrypted at rest and in transit and must be readable only by staff who need
   them. Deleting or changing logs must be limited to the log archive's administrators and
   alerted.
2. Application and infrastructure logs must be kept for [Log Retention]. The product audit log is
   kept for the life of the customer's account.
3. All systems must use synchronized time (UTC, NTP or the AWS time service).

### 6. Alerting

Alerts must go to the on-call engineer, with security alerts also to the [Security Officer]. At a
minimum, alert on:

| Area           | Alert                                                                           |
| -------------- | ------------------------------------------------------------------------------- |
| Authentication | Spikes in failed sign-ins, lockouts, replayed TOTP codes, or recovery code use  |
| Access         | Break-glass or AWS root use; IAM policy changes; new access keys                |
| Keys           | KMS key disabled, scheduled for deletion, or policy changed; decrypt failures   |
| Data           | Unusual volume of reveals, exports or downloads; public access on a bucket      |
| Availability   | Health check failures (`/health/ready` returns 503), error rate, latency        |
| Jobs           | Queue backlog, failed jobs, scheduled jobs that did not run                     |
| Integrity      | Audit log write failures; migration checksum refusals; logging pipeline stopped |
| Certificates   | TLS certificates near expiry                                                    |

1. Every alert must have an owner and a runbook entry saying what to do.
2. Alerts that may be security events must be triaged under the
   [Incident Response Plan](incident-response-plan.md).

### 7. Review

1. The on-call engineer must acknowledge alerts within the time set for their severity in the
   incident response plan.
2. The [Security Officer] or a delegate must review security dashboards and unresolved alerts at
   least weekly, and record the review.
3. Alert rules and their thresholds must be reviewed at least once a year, and after every
   incident they failed to catch.

### 8. Customer-facing notices

Users are emailed when their sign-in changes (password changed, MFA turned on, a recovery code
used, the account locked, a new device, a replayed code). These notices let customers detect
misuse of their own accounts and are sent through the job queue so they are retried.

## Roles and responsibilities

| Role               | Responsibilities                                                      |
| ------------------ | --------------------------------------------------------------------- |
| [Security Officer] | Owns this policy; reviews security alerts weekly; approves log access |
| [Engineering Lead] | Runs the logging pipeline, alert rules and on-call rotation           |
| On-call engineer   | Acknowledges and triages alerts                                       |
| Developers         | Log safely; add audit records for every state change                  |

## Exceptions

Exceptions must be documented, approved by the [Security Officer], and time-limited. No exception
may allow sensitive values in logs or changes to the audit log.

## Enforcement

Disabling logging or alerting without approval, or logging sensitive values, may lead to
disciplinary action.

## Related documents

- [Incident Response Plan](incident-response-plan.md)
- [Data Classification and Retention Policy](data-classification-and-retention-policy.md)
- [ADR 0003: Tenant isolation](../adr/0003-tenant-isolation-rls.md)
- [ADR 0027: Jobs and observability](../adr/0027-jobs-and-observability.md)

## Revision history

| Version | Date             | Change          | Approved by |
| ------- | ---------------- | --------------- | ----------- |
| 1.0     | [Effective Date] | Initial version | [Approver]  |
