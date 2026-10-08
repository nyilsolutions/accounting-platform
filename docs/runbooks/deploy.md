# Deploy

Deploys run from GitHub Actions (`Deploy`, ADR 0030) after CI passes on `main`:

1. The images are built once and pushed to staging's ECR, tagged with the commit.
2. Staging is deployed.
3. A reviewer approves the `production` environment.
4. The same images are copied to production's ECR and production is deployed.

Each environment's deploy (`infra/deploy/ecs-deploy.sh`) registers new task definitions,
runs the **release step**, rolls the services, and checks `/healthz` and
`/api/health/ready`.

## Writing migrations that deploy safely

Migrations run before the new code, while the previous release is still serving requests,
and they aren't undone by a rollback. So every migration must work with both the old and
the new code:

- **Adding** a table, a nullable column, or a column with a default: safe.
- **Renaming or dropping** a column or table: do it in two releases. First stop using it, and
  ship. Then drop it in a later release.
- **Adding NOT NULL or a check to existing data:** first backfill (and make the code write
  it), ship, then add the constraint.
- **Indexes on large tables:** `create index concurrently` can't run inside the migrator's
  transaction. Create the index in its own migration file and check its build time against
  the perf data first.
- **Long locks:** avoid `alter table` that rewrites a large table. The release step has no
  timeout, but requests waiting on the lock do.

## When the release step fails

**Alarm:** `acct-<env>-release-failed`, and the deploy job fails at "running the release step"
with the step's log. Nothing was rolled out: the old tasks still run on the old code.

- **`Invalid configuration ...` or `... in production`:** a setting the API would refuse. Fix
  it in Terraform (`app_settings`, `provider_secret_names` and the secret's value) and run the
  workflow again.
- **A migration failed:** each migration runs in its own transaction, so the failed one left
  nothing behind; earlier ones in the same release stay applied. Fix the migration in a new
  commit. Never edit an applied migration; the migrator refuses changed checksums.
- **Can't connect:** the release task runs in the API's subnets and security group. Check the
  database is available and the `ADMIN_DATABASE_URL` secret is current (after rotating
  passwords, see [rotate secrets](rotate-secrets.md)).

## When a service doesn't become stable

ECS's circuit breaker rolls a service back to its previous task definition by itself, and the
deploy fails naming the service. The migrations stay. Read the stopped tasks' reasons
([service down](service-down.md)), fix, and deploy again.

## By hand

The workflow can be run by hand ("Run workflow") with an `image_tag`: the full SHA of an earlier
commit whose images exist. That is how to redeploy or [roll back](rollback.md).
