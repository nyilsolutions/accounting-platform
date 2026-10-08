# Backups

**Alarms:** AWS Backup `BACKUP_JOB_FAILED`, `COPY_JOB_FAILED`, `BACKUP_JOB_EXPIRED`,
`RESTORE_JOB_FAILED`, and `acct-<env>-s3-replication`.

- **What is backed up:**
  - point-in-time recovery for 35 days, in us-east-1 and us-west-2;
  - daily snapshots, kept 35 days;
  - monthly snapshots, kept 365 days;
  - copies of both in us-west-2 and the backup account;
  - documents versioned and replicated to us-west-2.
- **A failed backup job:** AWS Backup console > Jobs > the job shows the reason. Common ones:
  - the database was modifying or under maintenance: the next run usually succeeds; start an
    on-demand backup if a day was missed;
  - a KMS permission was removed: compare with Terraform.
- **A failed copy to the backup account:** the vault policy, the database key policy (it must
  allow the backup account) or AWS Organizations cross-account backup being off.
- **Replication failures:** S3 console > the documents bucket > Metrics > Replication. Usually
  a KMS permission of the replication role. Objects that failed are not retried by
  themselves; use S3 Batch Replication for them once fixed.
- **Retention changes** go through Terraform (`daily_backup_retention_days`,
  `monthly_backup_retention_days`) and must stay within the backup account's vault lock
  limits.
