# Disaster recovery

For losing the primary region (us-east-1), the production account, or the database beyond what
a point-in-time restore fixes. Declare a disaster under the business continuity plan first;
it names who may.

## What exists to recover from

| What            | Where                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Database        | Point-in-time recovery for 35 days replicated to us-west-2; daily and monthly snapshots copied to us-west-2 and the backup account |
| Documents       | `acct-production-documents-dr-<account>` in us-west-2 (replicated, versioned)                                                      |
| Field key       | The multi-region replica in us-west-2 (`field_kms_replica_arn` output)                                                             |
| Images          | ECR in the staging and production accounts; or rebuild from the repository                                                         |
| Everything else | This repository: Terraform, the deploy workflow, these runbooks                                                                    |

## Region loss: rebuild in us-west-2

The recovery region holds data, not a running copy, so expect hours (question 107).

1. **Infrastructure:** create a new root (copy `envs/production` to `envs/production-dr`). Swap
   the providers, so the primary is us-west-2 and `dr` is another region such as us-east-2.
   Point it at:
   - the restored database (next step) instead of a new one;
   - the replica bucket for documents;
   - the field key replica for `FIELD_KMS_KEY_ID`.

   These need module inputs for existing resources (an open item for the first annual drill).

2. **Database:** restore from the replicated automated backups in us-west-2 to the latest
   restorable time, into the new VPC's data subnets.
3. **Images:** push the last production images to the new region's ECR (`docker buildx
imagetools create`), or build them from the deployed commit.
4. **Release step and services:** deploy with the workflow pointed at the new environment. The
   release step finds the existing field keys, which unwrap with the replica.
5. **Check:** run the restore checks against the new database (as in the
   [restore drill](restore-drill.md)), then open the site.
6. **DNS:** point the app's name at the new load balancer.
7. **Mail:** verify the sending domain in SES in us-west-2 (new DKIM records) and request
   production access there; until then, mail-based steps wait.
8. Tell customers, under the incident plan.

## Account compromise

Treat the production account as untrusted. Restore from the **backup account's** locked vault
into a clean account built from this repository. Rotate every secret and provider credential
([rotate secrets](rotate-secrets.md)), and every person's access.

## The field key

The wrapped keys in `field_keys` are useless without the KMS key. Never schedule deletion of
the field key or its replica. KMS waits 30 days before deleting a key; cancel any deletion you
find (`aws kms cancel-key-deletion`) and treat it as an incident.
