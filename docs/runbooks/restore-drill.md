# Restore drill

Quarterly (business continuity plan, section 4), for production. It is also how to look at an
earlier state of the data without touching the live database.

## Run it

With administrator access to the environment's account, from the repository:

```bash
infra/drill/restore-drill.sh production                         # latest restorable time
infra/drill/restore-drill.sh production 2026-10-08T06:00:00Z    # a point in time
KEEP=1 infra/drill/restore-drill.sh production                  # keep the copy afterwards
```

It:

1. Restores the database to a new private instance (`acct-production-drill-<time>`) in the
   data subnets, and times it.
2. Runs the restore checks against the copy as a one-off release task:
   - every migration applied;
   - each company's books balance;
   - a sample of every encrypted column decrypts with the field keys through KMS;
   - a sample of documents reads back from S3 with its recorded SHA-256.
3. Prints the drill record and deletes the copy (unless `KEEP=1`).

It exits non-zero if any check fails.

## Record it

Paste the printed summary into the drill record. Add:

- **Time to restore** against the RTO, and **newest change found** against the restore
  point. The gap is the data loss window to compare with the RPO.
- Anything that didn't work, with an owner and a date.

## Also check, once a year

- **A copy in the recovery region:** restore from the replicated automated backups in
  us-west-2 (RDS console > Automated backups > Replicated). Check the field key replica
  decrypts there ([disaster recovery](disaster-recovery.md)).
- **A copy from the backup account's vault:** restore one snapshot in that account.
- **A document from the replica bucket** (`acct-production-documents-dr-<account>`).

## Rules

The copy holds customer data. It stays private in the data subnets, and nobody exports data
from it. It is deleted the same day unless an incident needs it.
