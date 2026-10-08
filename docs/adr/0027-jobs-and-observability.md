# ADR 0027: A Postgres job queue, structured logs and tracing (Phase 12a)

- Status: Accepted
- Date: 2026-10-07

## Context

Several earlier phases left background work in the API process:

- **Timers:** the e-file acknowledgement poller (ADR 0024), the EFTPS and payments-partner
  poller (ADR 0025) and the report scheduler (ADR 0014) ran on `setInterval`.
- **Fire-and-forget:** receipt reading after an upload or email ran on `setImmediate`, so it was
  lost if the process stopped.
- **Never automated:** the document purge (Phase 5) and a nightly bank download (Phase 4) were
  manual.

Logs were Nest's console text with nothing redacted by default, and there was no tracing.

The owner decided (2026-10-07):

- **AWS** is the cloud (Phase 12d).
- **A Postgres queue** (pg-boss) instead of BullMQ on Redis.
- **OpenTelemetry only** for traces and errors, with no vendor SDK.

## Decision

### The queue

- **Where jobs live:** pg-boss keeps them in the `pgboss` schema of the application database.
  Migration 0029 creates the schema.
- **Installing it:** `jobs:install` runs as the database owner after the migrations
  (`pnpm db:migrate` runs both). It installs or upgrades pg-boss's tables, creates one queue per
  job with its retry policy, and grants `acct_app` row access only. The app role still owns
  nothing (CLAUDE.md rule 3) and can't change the schema, which tests check.
- **The jobs** (`jobs/jobs.ts`), with times in UTC. Each one's data carries ids only.

  | Job                 | When                  | What                                                      |
  | ------------------- | --------------------- | --------------------------------------------------------- |
  | `documents.read`    | on upload or email-in | Read a receipt. Retried 3 times; one queued per document. |
  | `documents.purge`   | daily 03:17           | Remove deleted documents' bytes past retention.           |
  | `banking.sync`      | daily 06:23           | Download connections not downloaded in 20 hours.          |
  | `efile.acks`        | every 15 minutes      | Ask the transmitter for acknowledgements.                 |
  | `payroll.partners`  | every 15 minutes      | Ask EFTPS and the payments partner what changed.          |
  | `reports.scheduled` | every minute          | Email the memorized reports that are due.                 |

- **Handlers:** the owning services register them in `onModuleInit` (`JobQueue.register`). The
  queue knows no business code.
- **Cross-company jobs** find their companies through security-definer lookups that return ids
  only (`app_documents_purge_candidates`, `app_bank_connections_due`, and the existing
  e-file, partner and report lookups). Each company is then handled inside `withTenant()`, as
  in ADRs 0024 and 0025.
- **Who a job acts as:**
  - jobs act as nobody (`userId` null), or as the person whose work it is (the bank sync runs as
    whoever connected the bank, as webhooks do);
  - the request id in their audit rows is the job's id;
  - the daily purge writes an audit row only when it purged something.
- **Sending:** `JobQueue.send` can take a transaction (`tx`), so the job exists only if the
  change that needs it commits.

### Processes

- **One process (development):** `JOB_WORKER=on` (the default) runs jobs and fires schedules
  inside the API.
- **Production:** the API runs with `JOB_WORKER=off`. One or more `worker` processes
  (`pnpm --filter @acct/api worker`, `src/worker.ts`) run the jobs. pg-boss makes sure each job
  runs once and each schedule fires once, however many workers there are.
- **Stopping:** running jobs get 30 seconds to finish. Any left are retried by the next worker.
- **Tests:** `JOB_QUEUE=inline` runs a sent job in the same process right away (refused outside
  NODE_ENV=test), and `drain()` waits for it. Job tests use a real pg-boss queue and run what is
  queued.
- **The old flags are gone:** `REPORT_SCHEDULER`, `EFILE_ACK_POLLER` and
  `PAYROLL_PARTNER_POLLER`.

### Logs

- **The logger:** `JsonLogger` (`observability/logger.ts`) replaces Nest's console logger in
  the API and the worker. It writes one JSON object per line (`LOG_FORMAT=json`, the default in
  production) or a readable line (`pretty`), at `LOG_LEVEL`.
- **Context on every line:** the request id, the signed-in user's id (an id, never a name or
  email), the job, and the trace and span ids when tracing is on.
- **Redaction:** everything is redacted (`observability/redact.ts`):
  - SSNs, EINs, runs of 8–17 digits (bank, card and phone numbers) and bearer credentials are
    replaced;
  - email addresses keep only their domain;
  - fields named like secrets are dropped (passwords, tokens, SSNs, account and routing numbers,
    keys, signatures, MFA codes).

  This is a safety net. Code still must not log such values (CLAUDE.md rule 4).

- **One line per request:** method, path, status and duration. The query string is dropped, and
  path segments that look like tokens (pay links, sign-in links) become `:token`. Bodies,
  headers and cookies are never logged. Health checks aren't logged.

### Tracing

- **Starting it:** OpenTelemetry starts only when `OTEL_EXPORTER_OTLP_ENDPOINT` (or
  `..._TRACES_ENDPOINT`) is set. Traces then go over OTLP to whatever backend is chosen later
  (question 84).
- **What is traced:** HTTP requests (not health checks), Express routes, and Postgres queries.
  Queries are recorded as statements with `$n` placeholders, never their values, and only
  inside a request or job.
- **Scrubbing:** `RedactingExporter` scrubs every span before export:
  - URL attributes lose their query strings and tokens;
  - query strings, cookies and user agents are dropped;
  - strings and error messages are redacted like log lines.
- **Where it starts:** it is the first import of `main.ts` and `worker.ts`, so it is in place
  before http, Express and pg load.

### Health

- `/health/live`: the process is up, without touching dependencies, so an orchestrator doesn't
  restart it during a database outage.
- `/health/ready`: the database and the job queue answer. A 503 names which one is down, and
  nothing more.
- `/health` stays for existing probes.

## Consequences

- **Durability:** background work survives restarts and deploys, retries where retrying makes
  sense, and scales by adding workers. There is no new service to run, back up or secure.
- **Logs and traces** can be shipped anywhere without carrying personal data, and a line can be
  followed to its request, user and trace.
- **Deploys** must run `pnpm db:migrate` (which now installs the queue) before starting new code.
- **Migration imports and QuickBooks Online pulls** still run in the API process. They need a
  closing password that must not be stored in a job, and they hold a lock that shows them as
  running (question 85).

## Not in this part

- **Where logs and traces go** (question 84).
- **Alerting:** queue backlogs, failed jobs and error rates (12d, with the AWS setup).
- **Re-scanning stored files** when virus signatures update (question 86).
