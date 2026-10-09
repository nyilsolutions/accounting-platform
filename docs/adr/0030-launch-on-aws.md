# ADR 0030: Launch on AWS (Phase 12d)

- Status: Accepted
- Date: 2026-10-08

## Context

The platform has to run for customers: in containers, from code, with backups that are tested,
alarms that reach someone, and a deploy that can't skip its checks. The owner decided
(2026-10-08):

- **Compute:** ECS on Fargate.
- **Database:** RDS for PostgreSQL, Multi-AZ.
- **Email:** Amazon SES.
- **Environments:** staging and production in separate AWS accounts, in us-east-1.

Earlier parts fixed the rest: AWS (Phase 12), pg-boss jobs and a separate worker (ADR 0027),
the performance targets (ADR 0028), KMS field keys, ASVS Level 2 and the SOC 2 policies
(ADR 0029). The business continuity plan (`docs/policies/`) asks for backups in a second
region and a separate account, a multi-region field key, quarterly restore drills and alerts
on failed backups.

## Decision

### 1. Images

One `Dockerfile`, three targets, built once per commit and promoted unchanged:

- **`api`**: the API (`dist/main.js`), the worker (`dist/worker.js`) and the release step
  (`dist/release.js`) from the same code.
- **`web`**: the Next.js standalone server. The web app's `/api` rewrite is fixed at build
  time, so the image is built for the API's address in the cluster
  (`http://api.acct.internal:4000`).
- **`clamd`** (question 104): ClamAV's daemon and freshclam from Debian 13's packages, so
  nothing in a task comes from a third-party image or Docker Hub. The image carries the
  signatures from its build; each task copies them into its volume and freshclam fetches what
  changed since, so a new task is ready at once without a full download, which ClamAV's
  mirrors limit. The build date is a build argument, so the signature layer is refreshed at
  most once a day.

`api` and `web` run as the unprivileged `node` user over root-owned files, and `clamd` as
`clamav` (999). All three have a read-only root filesystem and no Linux capabilities on ECS.
The paths they write to are declared as `VOLUME`s after being given to their user, because ECS
creates a task's volumes with the ownership the image declares there (root otherwise). The
Node and Debian base images are pinned by digest (Dependabot updates them). The API image
trusts the Amazon RDS certificate authorities so `sslmode=verify-full` works.

CI builds the three images and starts them: the release step, API, worker and web against
Postgres, and clamd as on ECS, checked with the antivirus test file and a 30 MB file through
the API's own scanner client. It scans them with Grype (high and critical vulnerabilities
that have a fix fail the build). ECR scans them again continuously with Amazon Inspector.

### 2. Infrastructure as code

Terraform in `infra/terraform`: one module (`modules/platform`) applied per environment
(`envs/staging`, `envs/production`), each in its own account. us-west-2 is the recovery
region. A third account holds a locked backup vault (`envs/backup`).

- **Network:** a VPC with three tiers per zone:
  - public (load balancer, NAT);
  - app (ECS tasks, no public IPs);
  - data (the database, with no route out).

  Production uses three zones with a NAT gateway each; staging uses two zones and one NAT
  gateway. AWS services are reached through VPC endpoints. Flow logs are on.

- **Database:**
  - RDS PostgreSQL 16, Multi-AZ, gp3, encrypted with its own KMS key;
  - TLS required (`rds.force_ssl`), slow statements logged;
  - Performance Insights and enhanced monitoring;
  - deletion protection;
  - automatic minor upgrades only.
- **Roles:** the master user (`acct_owner`) owns the schema and runs the release step. The
  app connects as `acct_app`, which the release step creates (CLAUDE.md rule 3).
- **Services** (ECS Fargate):
  - `web` sits behind the load balancer;
  - `api` runs with clamd as a sidecar (`CLAMD_HOST=127.0.0.1`, the `clamd` image) and
    `JOB_WORKER=off`, and scales on CPU;
  - `worker` runs jobs and schedules. It has no clamd, because files are scanned only when
    they are uploaded, which the API handles;
  - `release` is a one-off task.

  Every service has the deployment circuit breaker with rollback.

- **Service discovery:** the web tasks find the API through Cloud Map DNS
  (`api.acct.internal`), with one record per healthy task. There is no proxy in between
  (Service Connect would add Envoy), so the network path is the one tested locally.
- **Load balancer:**
  - HTTPS only, TLS 1.2 and 1.3 (`ELBSecurityPolicy-TLS13-1-2-Res-2021-06`), HTTP redirected;
  - invalid headers dropped, strictest desync mitigation, access logs;
  - AWS WAF in front, with the AWS IP reputation, common and known-bad-input rules and a
    per-IP rate limit. The common rules' 8 KB body check only counts, because uploads are
    larger and the API has its own limits. Only blocked requests are logged, with cookies
    redacted.
- **Client IPs (question 96):** the load balancer appends the client's address to
  `X-Forwarded-For`. The web app's proxy passes the header through and adds nothing. The API
  trusts only hops inside the VPC (`TRUST_PROXY=loopback, <VPC CIDR>`), so its client IP is
  the address the load balancer added, whatever the client sent. This was tested through the
  web container: a spoofed header is ignored. A CDN in front would need its ranges added.
- **Storage:** documents in S3 are:
  - encrypted with SSE-KMS under our key (a policy refuses other keys);
  - versioned, TLS only, never public;
  - replicated to us-west-2, with replication time control;
  - kept 35 days as old versions after the app's retention purge.

  Downloads can go straight to S3 through presigned links (`FILES_ORIGIN` for the CSP).

- **KMS keys, all rotated yearly:**
  - `field` wraps the field data keys and is multi-region, with a replica in us-west-2;
  - `storage` covers documents, Secrets Manager, ECR and the backup vault;
  - `database` covers RDS;
  - `logs` covers CloudWatch Logs and SNS;
  - a key in the recovery region covers the copies kept there.
- **Mail:**
  - SES v2 sends raw MIME (`MAIL_TRANSPORT=ses`, now required in production) through a
    configuration set that requires TLS and suppresses bounces and complaints;
  - the domain has Easy DKIM (2048-bit), a custom MAIL FROM domain for SPF alignment and a
    DMARC record;
  - delivery problems go to an SNS topic.
- **Identity:** S3, SES and KMS calls use the task role's temporary credentials. The SigV4
  signer now signs the session token, checked against the AWS reference signer. Static S3 keys
  remain only for other S3-compatible stores. Task roles have least privilege:
  - the API and worker can read and write documents, decrypt field keys (only with our
    encryption context) and send mail;
  - the release role can also generate and wrap field keys, and read documents for the
    restore drill;
  - the web role can do nothing;
  - only the execution role reads Secrets Manager.

  ECS Exec is on for break-glass access (CloudTrail records it).

- **Secrets:** database passwords, `SIGNING_KEY` and `PASSWORD_PEPPER` are generated with
  ephemeral `random_password` resources and written through write-only attributes. They are
  never in the plan or the state. Version variables rotate the database passwords and the
  signing key. The pepper has no version, because changing it would lock everyone out.
  Provider credentials are created as empty secrets that an operator fills in.
- **Account security:**
  - CloudTrail in every region with log file validation and S3 data events for documents;
  - GuardDuty (S3, RDS sign-ins, ECS runtime monitoring) with findings to the alarm topic;
  - IAM Access Analyzer.

### 3. Deploys

`.github/workflows/deploy.yml` runs after CI passes on `main`:

1. Build the images once, with provenance and an SBOM, and push them to staging's ECR, tagged
   with the commit.
2. Deploy to staging.
3. Production waits for a reviewer on the GitHub `production` environment.
4. Copy the same images to production's ECR by digest, then deploy to production.

GitHub OIDC roles can be assumed only by this repository's jobs running in the environment of
the same name; there are no AWS keys in GitHub. ECR tags are immutable.

`infra/deploy/ecs-deploy.sh` (tested against a fake AWS CLI in CI) deploys an environment:

1. It registers new task definition revisions with the new images; everything else stays as
   Terraform set it, and Terraform ignores the revision.
2. It runs the release step and stops if that fails.
3. It rolls the services and waits for them to be stable. It fails if ECS rolled any of them
   back.
4. It checks `/healthz` and `/api/health/ready` through the load balancer.

The **release step** (`ops/release.ts`) runs before any new code, and is safe to repeat:

1. It checks the app's settings exactly as the API will, so a bad setting stops the deploy
   before anything changes.
2. It sets the app role and its password.
3. It applies the migrations and installs the job queue.
4. With KMS field keys and none in the database, it creates the first key version. Without
   one the API refuses to start, so a first launch needs no manual step.

Because migrations run before the new code and old tasks keep running during the roll,
migrations must be **backward compatible**: expand first, contract in a later release
(`docs/runbooks/deploy.md`). Rollback means deploying an earlier commit's images, which
the workflow takes as an input; migrations aren't reversed.

### 4. Backups and restore drills

- **Point-in-time recovery for 35 days** (the RDS maximum), with automated backups and
  transaction logs replicated continuously to us-west-2.
- **AWS Backup:** daily snapshots kept for 35 days and monthly snapshots kept for 365 days,
  each copied to us-west-2. Once the backup account exists, each is also copied to its vault.
  That vault has a compliance-mode lock, so not even its root user can delete a copy early.
  The database key lets the backup account copy.
- **Documents:** S3 versioning and replication; failed replication raises an alarm.
- **Field key:** the multi-region replica means the wrapped keys in a restored `field_keys`
  table can be unwrapped in us-west-2.
- **Restore drill** (`infra/drill/restore-drill.sh`, quarterly):
  1. Restore a point-in-time copy into the data subnets, and time it.
  2. Run the restore checks (`ops/verify-restore.ts`) against it as a one-off release task:
     - every migration applied;
     - each company's posted journal lines balance;
     - a sample of every encrypted column decrypts through KMS;
     - a sample of documents read back with their recorded SHA-256;
     - the newest audit row, to measure the data loss window.

     The checks print counts and ids, never values.

  3. Print the drill record and delete the copy.
- **Failure alerts:** failed backup, copy and restore jobs go to the alarm topic.

### 5. Alerting

Every alarm goes to one KMS-encrypted SNS topic, which emails `alarm_emails`. Each alarm's
description names its runbook in `docs/runbooks/`.

- **Load balancer:** 5xx counts, unhealthy web tasks, and p95 response time over 2 s (the
  ADR 0028 target).
- **ECS:** running tasks below the desired count, API CPU and memory.
- **RDS:** CPU, storage, memory and connections, plus RDS events (failover, failure, low
  storage, maintenance).
- **SES:** bounce and complaint rates, below where SES starts reviewing an account.
- **S3:** failed replication.
- **Logs** (metric filters on the JSON logs): error lines from the API and worker (failed jobs
  log at error level), spikes of security events (ADR 0029), and a failed release step.
- **Events:** tasks that crash or fail to start, and GuardDuty findings of medium severity or
  higher.

Logs are kept in CloudWatch for 1 year (`log_retention_days`, the logging policy). Traces stay
off until a collector is chosen (question 84).

## Consequences

- **Cost:** production runs three NAT gateways, Multi-AZ RDS, at least two API tasks with
  clamd (4 GB each), two web tasks, a worker, WAF, GuardDuty and replication. Staging is
  smaller. The sizes are starting points to confirm on staging (question 87).
- **The first apply is in two steps:** the ECR repositories first, then the images, then
  everything else (`infra/terraform/README.md`). The launch checklist
  (`docs/launch-checklist.md`) covers what code can't do: domains, SES production access,
  provider secrets, GitHub environments, the backup account, the policies' placeholders.
- **Migrations:** every migration has to be safe while the previous release is still running.
- **Recovery region:** us-west-2 holds data, not a running copy. A region failure means
  rebuilding there from the code and the replicated backups (`docs/runbooks/disaster-recovery.md`),
  so the RTO is hours (question 107).
- **Cross-account backup copies** need AWS Organizations with cross-account backup turned on
  (question 101).
- **CI** now builds and scans the images on every pull request and runs the Terraform tests
  against mocked AWS. Nothing in CI touches AWS; only the deploy workflow does.
