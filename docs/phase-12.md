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
| 12b  | Performance: 100,000-transaction data, query and index work, load tests against the targets            | This PR |
| 12c  | Security: AWS KMS field encryption, an ASVS review and fixes, CI scanning, data export, SOC 2 policies | Planned |
| 12d  | Launch: containers, Terraform for AWS, backups and a restore drill, alerting, the launch checklist     | Planned |

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
pnpm --filter @acct/api perf                                        # 2% scale, about 2 minutes
PERF_SCALE=full pnpm --filter @acct/api perf                        # full scale, about 25 minutes
PERF_SCALE=full PERF_DB_NAME=acct_perf pnpm --filter @acct/api perf # keep the data, reuse it next time
```

### Tests

TESTS_TABLE

### Not in this part

- **Sizes on AWS,** and whether "50 users" should mean the no-pause case (question 87).
- **Very long lists** that load every record (question 88).
