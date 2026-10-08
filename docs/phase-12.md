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
| 12a  | Background jobs (a queue and worker), structured redacted logs, tracing, health checks                 | This PR |
| 12b  | Performance: 100,000-transaction data, query and index work, load tests against the targets            | Planned |
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
