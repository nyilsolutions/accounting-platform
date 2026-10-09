# Data Classification and Retention Policy

- **Owner:** [Security Officer]
- **Approved by:** [Approver]
- **Effective:** [Effective Date]
- **Next review:** [Review Date]
- **Version:** 1.0

## Purpose

This policy sorts [Company]'s information into classes, sets how each class must be handled, and
sets how long data is kept and how it is deleted or returned to customers.

## Scope

All information [Company] creates, receives or stores, in any system or form, including customer
data in the platform, backups, logs, exports, staff devices and vendor systems.

## Policy

### 1. Classes

- **Restricted:** SSNs, EINs, TINs, bank account and routing numbers, and credentials: passwords,
  MFA secrets and codes, recovery codes, session and one-time tokens, API keys, OAuth tokens,
  and encryption and signing keys.
- **Confidential:** company books and transactions, payroll and pay stubs, employee and
  contractor records (names, addresses, pay, withholding), customer and vendor lists, attached
  documents and receipts, tax filings, audit logs, data exports and security findings.
- **Internal:** source code, architecture and ADRs, internal procedures, and non-sensitive
  metrics.
- **Public:** the marketing site, published help content, and published policies and status
  pages.

1. Data takes the highest class of anything it contains. A file with one SSN is Restricted.
2. Data whose class is unknown must be treated as Confidential until the [Security Officer]
   decides.

### 2. Handling rules

| Rule                                 | Restricted        | Confidential        | Internal      | Public   |
| ------------------------------------ | ----------------- | ------------------- | ------------- | -------- |
| Field-level encryption               | Required          | No                  | No            | No       |
| Storage encryption (KMS)             | Required          | Required            | Required      | No       |
| TLS in transit                       | Required          | Required            | Required      | Required |
| Shown in full                        | Step-up, audited  | By role permission  | Staff only    | Anyone   |
| In logs, traces, audit log, job data | Never             | Ids only            | Allowed       | Allowed  |
| In email, chat or tickets            | Never             | Link to the product | Internal only | Allowed  |
| In non-production environments       | Never             | Never (real data)   | Allowed       | Allowed  |
| On paper or removable media          | Never             | Never               | Avoid         | Allowed  |
| Shared with vendors                  | Contract, minimum | Contract            | NDA           | Allowed  |

1. Restricted values must be shown masked (for example, the last four digits). The full value is
   shown only to a user with the reveal permission and an MFA code from the last 5 minutes, and
   each reveal is audited.
2. Vendors receive data only as set in the [Vendor Management Policy](vendor-management-policy.md).

Product rules that implement these:

1. Restricted values are encrypted with a row-bound AAD (ADR 0004) and never written to logs or
   the audit log (ADR 0027). Logs are also redacted as a safety net.
2. Tax ids, SSNs and bank and card numbers in QuickBooks data are dropped before an import is
   staged.
3. Requests to the licensed state tax engine never carry an SSN or bank number.
4. ACH files and full-SSN tax form exports are returned to the caller and never stored.
5. Download links for files expire after 5 minutes and are issued only after a permission check.

### 3. Retention schedule

| Data                                         | Kept for                                | How it ends              |
| -------------------------------------------- | --------------------------------------- | ------------------------ |
| Company books, payroll records, audit log    | Life of the account                     | Section 4                |
| Voided and deleted transactions              | With the books (the record is kept)     | Section 4                |
| Deleted documents' file contents             | The company's retention period (note 1) | Daily purge job          |
| Bank numbers in direct deposit requests      | Until the request is decided            | Database trigger (0033)  |
| Sessions, portal links, unused invitations   | 30 days after they end                  | Daily cleanup job (0033) |
| Company data exports                         | 7 days                                  | Daily expiry job (0034)  |
| Application logs and traces                  | 1 year                                  | Log store lifecycle rule |
| Database backups and snapshots               | 35 days; monthly snapshots 7 years      | Backup lifecycle rule    |
| Incident records, risk register, reviews     | At least 7 years                        | Annual manual review     |
| Staff records (checks, training, agreements) | As advised by [Legal Counsel]           | Annual manual review     |

Notes:

- **Note 1:** each company sets its document retention period in whole years (at least 4, the
  IRS minimum for employment tax records, and at most 100; default 7; migration 0007 and
  `documentSettingsSchema`). After that period, the daily `documents.purge` job removes the bytes of
  deleted documents; their metadata stays (ADR 0027).
- Migration numbers refer to `packages/db/migrations/`. The cleanup and expiry jobs are
  `security.cleanup` and `company.export.expire` in `apps/api/src/jobs/jobs.ts`.

1. Customers are responsible for their own legal record-keeping. The IRS, for example, requires
   employers to keep employment tax records for at least four years. The platform supports this
   by keeping records for the life of the account and by the data export in section 5.
2. Data under a legal hold set by [Legal Counsel] must not be deleted until the hold is lifted.
3. Retention periods that are not set by a product mechanism must be enforced by an automated
   lifecycle rule where possible, and otherwise reviewed at least once a year.

### 4. Deletion and disposal

1. When a customer closes their account, [Company] must delete the company's data from production
   within [Customer Deletion Period], unless a legal hold or law requires otherwise. Backups that
   contain it age out on their own schedule: up to 7 years for monthly snapshots, which can't be
   edited and are only read for a restore.
2. The app role cannot delete a company (ADR 0003). Deleting a company is an operator procedure,
   approved by the [Security Officer], recorded, and confirmed to the customer in writing.
3. Customer information that is no longer needed must be disposed of no later than two years
   after its last use for the customer, as the Safeguards Rule requires, unless a business or
   legal reason to keep it is recorded.
4. Media and devices must be wiped with a method that prevents recovery, or destroyed, before
   reuse or disposal. Cloud storage is disposed of by deleting the data and its keys; AWS handles
   physical media under its SOC 2 controls.
5. Deleting the KMS key or field data key versions makes encrypted values unrecoverable. This may
   be used as the final step of disposal only with [Security Officer] approval.

### 5. Customer data export

1. A company owner can export all of the company's data: every list, transaction, journal line
   and payroll record as CSV and JSON, and every current attached file, in one ZIP
   (`apps/api/src/data-export/data-export.service.ts`).
2. Only owners can request and download an export. A job builds it, stores it encrypted, and
   emails the owner a link to the page, never the file. Requests and downloads are audited.
3. SSNs, EINs, TINs and bank numbers are masked unless the owner asks for them with an MFA code
   from the last 5 minutes; downloading such an export needs a recent code too.
4. Credentials, password and token hashes, and encrypted secrets are never exported.
5. Exports are deleted after 7 days.
6. [Company] must honor a customer's export request before account deletion, and must tell the
   customer how to export when they ask to close their account.

### 6. Privacy requests

Requests from individuals (for example, employees of a customer) about their personal data must
go to the [Privacy Contact]. Because the customer controls its records, [Company] must pass the
request to the customer and help them answer it, unless the law requires [Company] to answer.

## Roles and responsibilities

| Role               | Responsibilities                                                                |
| ------------------ | ------------------------------------------------------------------------------- |
| [Security Officer] | Owns this policy; decides classes; approves deletions and key destruction       |
| [Privacy Contact]  | Handles privacy requests; keeps the retention schedule in line with privacy law |
| [Legal Counsel]    | Sets legal holds and legal retention periods                                    |
| [Engineering Lead] | Implements retention jobs and lifecycle rules; runs deletion procedures         |
| All staff          | Handle data by its class                                                        |

## Exceptions

Exceptions must be documented, approved by the [Security Officer], and time-limited. No exception
may allow Restricted data in logs, email or non-production environments.

## Enforcement

Mishandling data may lead to removal of access and disciplinary action, and may have to be
reported as an incident.

## Related documents

- [Encryption and Key Management Policy](encryption-and-key-management-policy.md)
- [Logging and Monitoring Policy](logging-and-monitoring-policy.md)
- [Incident Response Plan](incident-response-plan.md)
- [ADR 0004: Field encryption](../adr/0004-field-encryption.md)
- [ADR 0012: Documents](../adr/0012-documents.md)
- [ADR 0013: QuickBooks migration](../adr/0013-quickbooks-migration.md)

## Revision history

| Version | Date             | Change          | Approved by |
| ------- | ---------------- | --------------- | ----------- |
| 1.0     | [Effective Date] | Initial version | [Approver]  |
