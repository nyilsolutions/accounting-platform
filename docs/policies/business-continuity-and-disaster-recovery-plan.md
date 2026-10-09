# Business Continuity and Disaster Recovery Plan

- **Owner:** [Security Officer]
- **Approved by:** [Approver]
- **Effective:** [Effective Date]
- **Next review:** [Review Date]
- **Version:** 1.0

## Purpose

This plan sets how [Company] keeps the platform available, protects customer data against loss,
and restores service after a failure, from a single bad deploy to the loss of an AWS region.

## Scope

The production platform on AWS: the web app, API, job workers, the Postgres database (which also
holds the job queue), document and export storage in S3, KMS keys, secrets, DNS and certificates.
It also covers the third-party services the platform depends on, and the people who run it.

## Policy

### 1. Objectives

| Objective                      | Target     |
| ------------------------------ | ---------- |
| Recovery point objective (RPO) | 15 minutes |
| Recovery time objective (RTO)  | 4 hours    |

The targets cover losing the primary region too. There is no standby there (question 107), so
recovery is a rebuild from code and the replicated backups. The yearly disaster recovery drill
(section 4.2) measures that rebuild against the RTO. Mail can lag behind the RTO after a
region loss, because Amazon SES production access in the new region is granted by AWS, not by
us.

1. Payroll is time-critical: employees must be paid on their pay date and tax deposits made on
   time. Recovery must restore payroll, direct deposit and tax payment functions first.
2. The objectives must be reviewed every year against customer commitments and the results of
   restore drills.

### 2. Architecture for availability

1. Production must run in at least two availability zones in its primary region, with the
   database in a multi-AZ configuration that fails over automatically.
2. The API and job workers must run as multiple stateless instances. The job queue lives in the
   database, makes sure each job runs once however many workers there are, and retries jobs left
   by a stopped worker (ADR 0027).
3. Load balancers must use the health checks: `/health/live` for restarts and `/health/ready`
   (database and job queue) for traffic (ADR 0027).
4. Deploys must be rolling, with the previous version kept ready for rollback.

### 3. Backups

1. The database must have automated backups with point-in-time recovery for 35 days (the RDS
   maximum), daily snapshots kept for 35 days and monthly snapshots kept for 7 years, the same
   as the books. Staging, which holds no customer data, keeps monthly snapshots for 1 year.
2. Backups must be copied to a second AWS region and to a separate AWS account that production
   credentials cannot delete from (for example, with AWS Backup vault lock).
3. S3 buckets for documents and exports must have versioning on and be replicated to the second
   region. Document versions are written once and never overwritten.
4. Backups must be encrypted with KMS. The KMS key that wraps the field data keys must be a
   multi-region key, or otherwise available in the recovery region, because the wrapped keys in
   the `field_keys` table are useless without it.
5. Infrastructure code, the source repository and these policies are the means to rebuild
   everything else. The repository must be mirrored or backed up outside GitHub.
6. Backup jobs must be monitored, and a failed backup must raise an alert.

### 4. Restore drills

1. A database restore to a point in time must be tested at least every quarter in an isolated
   environment. The drill must:
   - measure the time to restore and compare it with the RTO;
   - check the data loss window against the RPO;
   - verify the restored data: migrations at the expected version, the trial balance ties out,
     sample encrypted fields decrypt, documents open;
   - record the result and any gaps.
2. A full disaster recovery drill (rebuilding the platform in the second region from code and
   backups) must be held at least once a year.
3. Restored environments contain customer data and must be protected like production, then
   destroyed when the drill ends.

### 5. Scenarios

| Scenario                         | Response                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Bad deploy                       | Roll back to the previous version; forward-fix a migration problem (migrations are append-only)                                  |
| Instance or zone failure         | Automatic: load balancer and multi-AZ database fail over                                                                         |
| Data corruption or deletion      | Point-in-time restore to a new database; copy back the affected rows after review                                                |
| Ransomware or account compromise | Incident response; restore from the separate backup account                                                                      |
| Region failure                   | Declare a disaster; rebuild in the second region from code and replicated backups; switch DNS                                    |
| KMS key unavailable              | The API cannot unwrap field keys at start; running instances continue. Restore access to the key or fail over to the replica key |

The [Security Officer] or the [Engineering Lead] may declare a disaster. The incident response
roles and contact tree apply.

### 6. Dependency outages

| Dependency                    | Effect of an outage                            | Continuity measure                                                                                |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Plaid (bank feeds)            | New bank transactions do not download          | The nightly download catches up; file import still works                                          |
| Stripe (online payments)      | Customers cannot pay invoices online           | Payments are recorded by hand; webhooks are handled once when delivered                           |
| Intuit (QuickBooks Online)    | Migrations from QuickBooks Online pause        | Retry later; reruns update rather than duplicate                                                  |
| IRS MeF and IRIS (e-file)     | Returns cannot be sent or acknowledged         | Submissions stay in their recorded state; acknowledgements are polled every 15 minutes            |
| EFTPS and the deposit partner | Tax payments or direct deposits cannot be sent | Status is polled every 15 minutes; a company can switch to the NACHA file rail for direct deposit |
| Licensed state tax engine     | Paychecks needing it cannot be calculated      | They are refused with a reason, never guessed                                                     |
| Email delivery                | Notices and scheduled reports are delayed      | Sends go through the job queue and are retried                                                    |
| Receipt reading service       | Receipts are not read automatically            | Jobs retry; users enter receipts by hand                                                          |
| Pwned Passwords               | The breach check cannot run                    | The password is allowed (the check fails open) and other rules still apply                        |
| European Central Bank         | Exchange rates are not updated                 | Rates are entered by hand                                                                         |
| GitHub                        | No merges or deploys                           | Production keeps running; emergency fixes wait or follow the emergency change process             |
| AWS KMS                       | New instances cannot start                     | See section 5                                                                                     |

1. Each critical vendor's own continuity arrangements must be checked in the vendor review.
2. When a dependency is down, the [Engineering Lead] decides whether to tell customers and posts
   on the status page.

### 7. People and communication

1. At least two people must be able to perform every recovery procedure. Runbooks must be stored
   where they can be reached when production and the primary identity provider are down.
2. Customers must be told about outages that affect them through the status page and, for long
   outages, by email.

### 8. Maintenance

This plan must be reviewed every year, after every drill, after every disaster declaration, and
when the architecture changes.

## Roles and responsibilities

| Role               | Responsibilities                                                           |
| ------------------ | -------------------------------------------------------------------------- |
| [Security Officer] | Owns this plan; may declare a disaster; reports drill results to the board |
| [Engineering Lead] | Runs backups, drills and recovery; may declare a disaster                  |
| On-call engineer   | First response to outages                                                  |

## Exceptions

Exceptions must be documented, approved by the [Security Officer], and time-limited. A missed
restore drill must be held within the following month.

## Enforcement

Failure to run backups or drills is reported to the board or owners in the annual report.

## Related documents

- [Incident Response Plan](incident-response-plan.md)
- [Encryption and Key Management Policy](encryption-and-key-management-policy.md)
- [Vendor Management Policy](vendor-management-policy.md)
- [ADR 0025: EFTPS and the deposit partner](../adr/0025-eftps-and-deposit-partner.md)
- [ADR 0027: Jobs and observability](../adr/0027-jobs-and-observability.md)
- [ADR 0028: Performance at scale](../adr/0028-performance-at-scale.md)

## Revision history

| Version | Date             | Change          | Approved by |
| ------- | ---------------- | --------------- | ----------- |
| 1.0     | [Effective Date] | Initial version | [Approver]  |
