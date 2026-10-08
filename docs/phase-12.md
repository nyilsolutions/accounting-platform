# Phase 12: Hardening and launch

Phase 12 makes the platform ready to run for customers. The owner decided (2026-10-07):

- **Cloud:** AWS.
- **Job queue:** a Postgres queue (pg-boss), not Redis.
- **Targets:**
  - 100,000 transactions and 5,000 customers per company;
  - report and list pages p95 under 2 s, and posting p95 under 300 ms;
  - 50 concurrent users per API instance with no errors.
- **Observability:** OpenTelemetry only, with no vendor SDK.

| Part | What                                                                                                   | Status  |
| ---- | ------------------------------------------------------------------------------------------------------ | ------- |
| 12a  | Background jobs (a queue and worker), structured redacted logs, tracing, health checks                 | Done    |
| 12b  | Performance: 100,000-transaction data, query and index work, load tests against the targets            | Done    |
| 12c  | Security: AWS KMS field encryption, an ASVS review and fixes, CI scanning, data export, SOC 2 policies | Done    |
| 12d  | Launch: containers, Terraform for AWS, backups and a restore drill, alerting, the launch checklist     | This PR |

## 12a: Jobs and observability (ADR 0027)

### Delivered

- **A job queue in Postgres:**
  - **Installing it:** `pnpm db:migrate` now also installs the queue as the database owner. The
    app role only gets row access.
  - **The worker:** `pnpm --filter @acct/api worker` runs jobs. In development the API runs them
    itself (`JOB_WORKER=on`).
- **Background work moved onto it:**
  - **Receipt reading** after an upload or email is queued (retried, once per document), so it
    survives restarts.
  - **E-file acknowledgements** and **EFTPS and payments-partner updates** run every 15 minutes.
  - **Scheduled reports** run every minute.
- **New scheduled jobs:**
  - a **daily purge** of deleted documents past their retention period, which was manual
    before;
  - a **nightly bank download** for connections not downloaded in 20 hours.
- **Logs:** one JSON line per event in production (a readable line in development).
  - **Redaction:** SSNs, EINs, bank numbers, emails and secrets are removed from every message
    and field.
  - **Context:** each line carries its request id, user id, job, and trace id.
  - **Requests:** each one is logged without its query string or tokens.
- **Tracing:** set `OTEL_EXPORTER_OTLP_ENDPOINT` to send traces of requests, routes and queries
  to any OpenTelemetry backend. URLs, strings and errors are scrubbed before they leave.
- **Health checks:**
  - `/health/live` says the process is up;
  - `/health/ready` checks the database and the job queue (503 naming which is down).

### Running it

```bash
pnpm db:migrate                       # migrations, then the job queue
pnpm dev                              # the API runs jobs itself (JOB_WORKER=on)

# production-like: the API doesn't run jobs; one or more workers do
JOB_WORKER=off pnpm --filter @acct/api start
pnpm --filter @acct/api worker
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm --filter @acct/api worker   # with tracing
```

### Tests

| Suite                   | Count | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db`           | 119   | +3: the app role can't create anything in the queue's schema; the purge and nightly bank lookups return ids only, and only what is due                                                                                                                                                                                                                                                                                                                                                  |
| `packages/shared`       | 158   | No change                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `apps/api`              | 623   | +18. **Queue:** installed by the owner, one queue per job, the app role can't change it; a job queued and run when drained; one read per document; queued inside a transaction, gone if it rolls back. **Jobs:** the daily purge, silent when nothing is due; the nightly bank download; every polling handler; two workers schedule each job once; readiness. **Logs and traces:** redaction of text, objects and paths; JSON lines with request, user and job context; span scrubbing |
| `apps/web` (Playwright) | 21    | No new test. The whole suite now runs against an API with the real queue and its worker on                                                                                                                                                                                                                                                                                                                                                                                              |

### Not in this part

- **Where logs and traces are shipped** (question 84) and alerting (12d).
- **QuickBooks imports** stay in the API process (question 85).
- **Re-scanning stored files** when virus signatures update (question 86).

## 12b: Performance at 100,000 transactions (ADR 0028)

### Delivered

- **A large company on demand:** `perf/generate.ts` builds 5,000 customers, 500 vendors and
  100,000 transactions over three years through the app's own services, so everything posts
  and ties as in real use. About 15 minutes; a 2% version takes about a minute.
- **A performance suite** (`pnpm --filter @acct/api perf`) against the API running as its own
  process:
  - 22 report and list pages, each 20 times, p95 under 2 s;
  - saving an invoice, p95 under 300 ms;
  - 50 people working at once for 2 minutes, with no errors and p95 under 2 s;
  - capacity with no pauses, reported;
  - a shutdown with requests running, none cut off.
- **Where it runs:** every pull request at 2% scale in CI; the full scale nightly and on demand
  (the Performance workflow), keeping results for 30 days.
- **Fixes** (details in ADR 0028):
  - JIT off on app connections;
  - receivable and payable reports read only open items;
  - register pages, P&L columns and cash-basis columns worked out in SQL or in one pass;
  - no collator built per comparison when sorting names;
  - saving a customer no longer loads them all;
  - shutdown waits for running requests before closing the database pool.
- **Settings:** `DB_POOL_SIZE` (default 10) and `RATE_LIMIT_PER_MINUTE` (default 600).

### Results

Full scale (100,000 transactions, 5,000 customers), 20 runs each, on the development container
(4 vCPUs, 16 GB, Postgres on the same machine). "Before" is the first run, for the pages that
failed it.

| Page                                          | Before (p95) | p50 ms | p95 ms |
| --------------------------------------------- | ------------ | ------ | ------ |
| Profit and Loss, this year                    |              | 103    | 118    |
| Profit and Loss by month, 3 years             | 2.7 s        | 887    | 1,106  |
| Profit and Loss, this year, cash basis        |              | 610    | 708    |
| Profit and Loss by month, 3 years, cash basis | 26 s         | 1,586  | 1,825  |
| Balance Sheet                                 |              | 500    | 731    |
| Trial Balance                                 |              | 515    | 606    |
| A/R Aging Summary                             | 2.1 s        | 706    | 782    |
| A/R Aging Detail                              |              | 758    | 875    |
| A/P Aging Summary                             |              | 280    | 351    |
| Open invoices                                 | 2.2 s        | 751    | 925    |
| Customer Balance Summary                      | 2.3 s        | 612    | 711    |
| Sales by Customer, 3 years                    |              | 184    | 263    |
| General Ledger, this year                     |              | 836    | 910    |
| Statement of Cash Flows                       |              | 291    | 405    |
| Customers list                                |              | 88     | 128    |
| Customer balances                             |              | 630    | 730    |
| Sales transactions, first page                |              | 12     | 20     |
| Open invoices list                            |              | 93     | 119    |
| Chart of accounts                             |              | 268    | 352    |
| Checking register, first page                 | 2.9 s        | 339    | 393    |
| Bank accounts                                 |              | 120    | 182    |
| Customer open items                           |              | 23     | 27     |
| **Save an invoice** (budget 300 ms)           |              | 24     | 30     |

- **50 users, 2 minutes:** 1,143 requests, no errors, p50 186 ms, p95 1,031 ms, slowest
  2.6 s.
- **Capacity, no pauses:** 50 connections for 60 s get 14 to 16 requests a second, p50 2.1 to
  2.4 s, with 4 to 19 requests over 10 s across the last two runs. The first run managed 2 a
  second, with 210 over 10 s. This is not a target (question 87).

### Running it

```bash
pnpm --filter @acct/api build
pnpm --filter @acct/api perf                                        # 2% scale, under 2 minutes
PERF_SCALE=full pnpm --filter @acct/api perf                        # full scale, about 25 minutes
PERF_SCALE=full PERF_DB_NAME=acct_perf pnpm --filter @acct/api perf # keep the data, reuse it next time
```

### Tests

| Suite                   | Count | Highlights                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db`           | 119   | No change                                                                                                                                                                                                                                                                                                                        |
| `packages/shared`       | 158   | No change                                                                                                                                                                                                                                                                                                                        |
| `apps/api`              | 627   | +4. **Register pages** match the full register (entries, running balances, totals, offsets past the end, date ranges). **Shutdown** counts a request until its handler answers, even after the client has gone. **Cash basis:** by-month P&L columns equal each month run alone, in the known-figures test and the property test |
| `apps/api` perf         | 26    | New. 22 pages and posting against their budgets, 50 users, capacity, shutdown. 2% scale on every pull request (72 s); full scale nightly                                                                                                                                                                                         |
| `apps/web` (Playwright) | 21    | No change                                                                                                                                                                                                                                                                                                                        |

### Not in this part

- **Sizes on AWS,** and whether "50 users" should mean the no-pause case (question 87).
- **Very long lists** that load every record (question 88).

## 12c: Security (ADR 0029)

The owner decided (2026-10-07): envelope encryption with one KMS-wrapped data key per version;
OWASP ASVS Level 2; a full data export (CSV and JSON with the files, owners only, sensitive
numbers masked unless the owner re-authenticates, an emailed link, 7 days); SOC 2 policies
with placeholders.

### Delivered

- **Keys in AWS KMS:** field data keys live in `field_keys`, wrapped by a KMS key, and are
  unwrapped once at start-up (`FIELD_KEY_PROVIDER=aws-kms`, required in production).
  `keys:status`, `keys:rotate` and `keys:reencrypt` rotate them without downtime; the old
  environment key is imported as version 1. Download links and OAuth state are signed with
  their own `SIGNING_KEY`.
- **ASVS Level 2 review** (`docs/security/asvs-l2.md`, threat model in
  `docs/security/threat-model.md`). Three reviews, each finding verified, each fix tested:
  - **sign-in:** separate MFA lockout, codes used once, a pepper, breached passwords refused,
    stronger recovery codes, change password, security emails;
  - **sessions:** 30 minutes idle, see and end sessions (Settings > Security), Clear-Site-Data;
  - **step-up:** a fresh MFA code for revealing SSNs and EINs, direct deposit, members,
    payments, approvals and the full export (the web asks for it and retries);
  - **access:** agent keys tied to their creator's role, portal lists by permission, customer
    portal links of 10 minutes that end when the customer is inactive or their email changes;
  - **input and files:** zip bombs, safe download extensions, compressed and unread body
    types (415), formula-safe CSV, linear OFX and IIF parsing, checked QuickBooks download
    links, NUL characters;
  - **headers and configuration:** no-store, a nonce CSP and HSTS on pages, JSON as
    attachments, TLS to every service required in production;
  - **errors and logs:** generic messages, last-resort handlers, security events;
  - **business logic:** one liability payment at a time, a closing date password attempt
    limit, a checkout limit per pay link;
  - **retention:** purges clear extracted text and search, decided requests drop bank numbers,
    expired sessions and links are deleted.
- **Scanning in CI:** CodeQL for TypeScript and C#, dependency audits (npm and NuGet), gitleaks,
  Dependabot; actions pinned to commits with read-only tokens.
- **Export all data** (Settings): owners get every table as CSV and JSON plus the attached
  files in one ZIP, built by a job, emailed as a link to the page, kept 7 days.
- **Policies** (`docs/policies/`): the SOC 2 set, with a fill-in list of placeholders.

### Running it

```bash
# A keyring wrapped by a local key (development); production uses aws-kms and FIELD_KMS_KEY_ID.
FIELD_KEY_PROVIDER=local-wrap FIELD_KEY_WRAPPING_KEY=... SIGNING_KEY=... \
  ADMIN_DATABASE_URL=postgres://... pnpm --filter @acct/api keys:rotate
pnpm --filter @acct/api keys:status      # values per key version
pnpm --filter @acct/api keys:reencrypt   # after restarting the API and workers
```

### Tests

| Suite                   | Count | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db`           | 121   | +2. The keyring table is read-only to the app                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/shared`       | 165   | +7. Safe redirects, password strength, safe download extensions, linear OFX parsing                                                                                                                                                                                                                                                                                                                                                         |
| `packages/crypto`       | 22    | +9. Key wrapping (KMS context, local stand-in), GCM tag length, pepper, recovery codes, TOTP replay, base32                                                                                                                                                                                                                                                                                                                                 |
| `apps/api`              | 670   | +43. **Keys:** rotate, import, re-encrypt every registered column, refuse the public key. **Sign-in:** MFA lockout, replay, step-up, password change, sessions, breach check. **Files and input:** 415, gzip, NUL, zip bombs, extensions, SSRF, ReDoS. **Logic:** concurrent liability payments pay once, closing password limit, checkout limit, cleanup. **Export:** owners only, masked or full with step-up, the ZIP's contents, expiry |
| `apps/web` (Playwright) | 24    | +3. Security page and step-up, the CSP on every page with no violations, exporting all data                                                                                                                                                                                                                                                                                                                                                 |

### Not in this part

- **12d infrastructure:** secrets in Secrets Manager, the KMS key policy, log shipping and
  alarms (question 84), the load balancer's TLS policy and forwarded IPs (question 96).
- **Open questions 89 to 99:** passkeys, registration and existing accounts, storage quotas,
  an SBOM, deleting accounts and companies, signing the Desktop agent, parsers in their own
  process, very large exports, pay link expiry, email-in replays.
- **The policies' placeholders** need the company's details and an approver
  (`docs/policies/README.md`).

## 12d: Launch on AWS (ADR 0030)

The owner decided (2026-10-08): ECS on Fargate, RDS PostgreSQL Multi-AZ, Amazon SES, and
staging and production in separate AWS accounts in us-east-1.

### Delivered

- **Images** (`Dockerfile`):
  - `api` runs the API, the worker and the release step;
  - `web` is the Next.js standalone server, built for the API's address in the cluster.

  Both run as non-root over read-only files, from a Node base image pinned by digest. CI
  builds both, runs them against Postgres (release step, API, worker, web, and `/api`
  through the web proxy), and scans them with Grype.

- **The release step** (`node dist/release.js`, `ops/release.ts`), run before every deploy:
  1. checks the settings as the API will;
  2. creates or updates the `acct_app` role;
  3. migrates and installs the job queue;
  4. creates the first KMS field key on a new database.
- **AWS from code** (`infra/terraform`):
  - **network:** a VPC with public, app and isolated data subnets, NAT, endpoints and flow
    logs;
  - **database:** RDS PostgreSQL 16, Multi-AZ, TLS only, KMS-encrypted;
  - **storage:** S3 for documents (SSE-KMS, versioned, replicated to us-west-2);
  - **keys:** KMS keys, with the field key multi-region;
  - **services:** ECS Fargate (web, API with clamd, worker, release task) behind an HTTPS load
    balancer with AWS WAF;
  - **mail:** SES with DKIM, MAIL FROM, DMARC and a suppression list;
  - **secrets:** Secrets Manager, generated write-only so they're never in the state;
  - **roles:** least-privilege task roles, and GitHub OIDC deploy roles per environment;
  - **account security:** CloudTrail, GuardDuty and Access Analyzer;
  - **layout:** one module, applied per account, plus a locked vault in a separate backup
    account.
- **Mail through SES** (`MAIL_TRANSPORT=ses`, required in production). S3, SES and KMS use the
  task role's temporary credentials; the SigV4 signer signs session tokens.
- **Client IPs (question 96):** the API trusts `X-Forwarded-For` hops inside the VPC only, so it
  sees the address the load balancer appended. A spoofed header is ignored, which was tested
  through the web container.
- **Deploys** (`.github/workflows/deploy.yml`, `infra/deploy/ecs-deploy.sh`):
  1. After CI passes on `main`, the images are built once and staging is deployed.
  2. Production waits for a reviewer, then gets the same images by digest.
  3. Each deploy registers new task definitions and runs the release step, which must pass.
  4. The services roll, with ECS rolling back unhealthy tasks, and the site is checked.

  Rollback means deploying an earlier commit's images.

- **Backups:**
  - point-in-time recovery for 35 days, replicated to us-west-2;
  - daily and monthly AWS Backup snapshots, copied to us-west-2 and to the backup account's
    locked vault;
  - document replication;
  - an alert on any failed backup, copy or replication.
- **Restore drill** (`infra/drill/restore-drill.sh`): restores a point-in-time copy and times
  it, then checks it with `ops/verify-restore.ts`:
  - migrations complete;
  - books balance per company;
  - encrypted fields decrypt through KMS;
  - documents match their SHA-256.

  It records the result, then deletes the copy.

- **Alerting:** alarms on 5xx, p95 over 2 s, unhealthy or missing tasks, database CPU, storage,
  memory and connections, SES bounce and complaint rates, replication, error and
  security-event spikes in the logs, failed release steps, crashed tasks, RDS events and
  GuardDuty. They all go to one SNS topic, and each alarm names its runbook.
- **Runbooks** (`docs/runbooks/`): one per alarm group, plus deploy, rollback, restore drill,
  disaster recovery and rotating secrets.
- **Launch checklist** (`docs/launch-checklist.md`): what code can't do. That covers
  accounts, DNS, SES production access, provider secrets, GitHub environments, the first
  drill, the policies and people.

### Running it

```bash
docker build --target api -t acct-api .
docker build --target web --build-arg API_URL=http://localhost:4000 -t acct-web .
docker run --rm --network host -e ADMIN_DATABASE_URL=... -e APP_DB_PASSWORD=... acct-api node dist/release.js

cd infra/terraform/modules/platform && terraform init -backend=false && terraform test
bash infra/deploy/test/ecs-deploy.test.sh
infra/drill/restore-drill.sh production      # with administrator access to the account
```

### Tests

| Suite                        | Count | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db`                | 123   | +2. The app role is created with no special powers and reset on each run                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `apps/api`                   | 684   | +14. **SES:** MIME round trip with a Unicode subject and attachment, header injection refused. **Role credentials:** session tokens signed like AWS's reference signer, fresh credentials per request. **Release step:** refuses bad settings before changing anything, creates the role and first field key, repeats safely. **Restore checks:** pass on real books, files and secrets; catch a changed file, an undecryptable value, unbalanced books, a missing migration. **Production settings:** a complete valid set loads |
| Terraform (`terraform test`) | 3     | Against mocked AWS: Multi-AZ, encrypted, private, TLS-only database; multi-region field key; no public IPs; TLS 1.2+ and redirects; deploy roles per repository environment; clamd beside the API; client IP trust; non-root read-only containers; owner URL only in the release task; backups copied to the recovery region and the backup account; CloudTrail                                                                                                                                                                   |
| Deploy script                | 12    | Against a fake AWS CLI: only images change in task definitions, the release step runs first and stops the deploy when it fails, a service ECS rolled back fails the deploy                                                                                                                                                                                                                                                                                                                                                        |
| Images (CI)                  | 1     | Release step, API, worker and web start from the images against Postgres; `/api` works through the web proxy; Grype finds no fixable high or critical vulnerability                                                                                                                                                                                                                                                                                                                                                               |

### Not in this part

- **Applying it:** nothing here has been applied to a real AWS account. The launch checklist
  covers the first apply, DNS, SES production access, provider secrets and GitHub
  environments.
- **Open questions 100 to 108:**
  - RPO, RTO and retention values;
  - the AWS Organization and backup account;
  - domains;
  - paging;
  - the clamd image's source;
  - who approves production deploys;
  - WAF limits;
  - a standby in the recovery region;
  - automatic password rotation.

  Questions 84 (traces) and 87 (sizes) are updated.
