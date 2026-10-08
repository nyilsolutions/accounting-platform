# Rollback

Use this when a release causes errors and fixing forward would take longer than going back.
Migrations aren't reversed; they are written to work with the previous release
([deploy](deploy.md)).

## The usual way: deploy an earlier build

1. Find the last good commit: GitHub Actions > Deploy > the last successful run before the
   bad one. Its image tag is the commit SHA.
2. Actions > Deploy > **Run workflow**, with `image_tag` set to that full SHA. It skips the
   build, deploys staging, and production after approval.

## Fastest, for production only: the previous task definitions

When minutes matter, put each service back on its previous revision directly (the revisions
are kept):

```bash
for s in api worker web; do
  current=$(aws ecs describe-services --cluster acct-production --services $s \
    --query 'services[0].taskDefinition' --output text)
  previous="${current%:*}:$(( ${current##*:} - 1 ))"
  aws ecs update-service --cluster acct-production --service $s --task-definition "$previous"
done
aws ecs wait services-stable --cluster acct-production --services api worker web
```

Check the revision numbers first: each deploy registers one revision per family, so "minus
one" is the previous deploy only if nothing else registered revisions since. Afterwards, run
the workflow with the same tag so staging and the record match.

## After a rollback

- Write down the bad commit in the incident ticket, and revert or fix it on `main`. The next
  push to `main` deploys again.
- If the bad release wrote data in a new shape that the old code misreads, fix that data
  through the services (and an audit trail), never by editing rows by hand.
