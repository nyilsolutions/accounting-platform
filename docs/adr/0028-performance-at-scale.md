# ADR 0028: Performance at 100,000 transactions (Phase 12b)

- Status: Accepted
- Date: 2026-10-07

## Context

The owner set the targets for launch (2026-10-07):

- **Data:** 100,000 transactions and 5,000 customers in one company.
- **Reads:** every report and list page p95 under 2 s.
- **Posting:** saving a transaction p95 under 300 ms.
- **Load:** 50 concurrent users on one API instance with no errors.

Until now every test company had tens of transactions, so nothing measured these.

## Decision

### Building the data

- **Through the services:** `perf/generate.ts` creates the company through the same services
  the API uses (customers, vendors, invoices, payments, bills, bill payments, expenses). Every
  document posts through PostingService (CLAUDE.md rule 2), so the subledgers tie and the data
  looks like a real company's: three years of dates, one to three lines per invoice, three
  quarters of invoices paid, two thirds of bills paid.
- **Deterministic:** a seeded generator, so runs compare.
- **Two scales:** `full` is the target (5,000 customers, 500 vendors, 100,000 transactions:
  40,000 invoices, 30,000 payments, 15,000 bills, 10,000 bill payments, 5,000 expenses) and
  takes about 15 minutes. `smoke` is the same shape at 2% and takes about a minute.

### Measuring

- **The suite** (`perf/perf.perf.ts`, `pnpm --filter @acct/api perf`) runs the API as its own
  process (`node dist/main.js`, jobs off) against the generated company, over HTTP with a
  signed-in session, as a browser would.
- **Reads:** 20 report and list pages the app opens on, each 20 times (5 at smoke scale). The
  test fails when a p95 is over 2 s.
- **Posting:** 50 invoices saved one after another. The test fails when the p95 is over 300 ms.
- **50 users:** 50 simulated people for 2 minutes (20 s at smoke scale). Each opens the sales
  list, customers, P&L, A/R aging or a register page, or saves an invoice, then takes 2 to 8
  seconds before the next (a busy person clicking every 5 seconds on average). Any error or
  non-2xx response fails the test, and so does a p95 over the 2 s page budget.
- **Capacity:** the same mix from 50 connections with no pauses at all, for 60 s. It isn't a
  target: it shows how much headroom one instance has. A request over 10 s counts as a timeout
  and is reported; any non-2xx response fails the test.
- **Shutdown:** a SIGTERM with 20 slow requests running. Every one must finish or be refused,
  none cut off halfway.
- **Results** go to `perf/results/<scale>.json`. `PERF_DB_NAME` keeps the generated database
  and reuses it on the next run, for working on one slow query.
- **Where it runs:**
  - CI runs the smoke scale on every pull request. It catches a query that gets much slower,
    not a few percent.
  - `.github/workflows/perf.yml` runs the full scale nightly and on demand, and keeps the
    results for 30 days.

### What was slow, and the fixes

The first full run failed six budgets, and 50 connections with no pauses managed 2 requests
per second with 210 timeouts. The fixes:

- **No JIT.** Postgres JIT-compiled every large report query on every run because the plans'
  costs crossed its threshold. On the A/R queries compiling took half the time (290 ms of
  594 ms). App connections now start with `jit=off` (`createDb`).
- **Open subledger items only.** The A/R and A/P reports, collections and party balances read
  every invoice and payment ever posted and dropped the settled ones in Node: 70,000 rows to
  keep 10,000. `openItems(..., { openOnly: true })` filters in SQL. Statements and the tie-out
  still read everything; they need settled items.
- **The control accounts first.** The "other postings to A/R or A/P" query joined accounts by
  type, so the planner couldn't tell how many lines it would get and looked each one's
  transaction up (70,000 lookups). With the control accounts' ids it hashes the transactions
  (179 ms to 67 ms).
- **Register pages in SQL.** A register read every entry of the account, with the payee and
  other account for each, to show 200. The running balance, count, ending and cleared balances
  are now worked out in one query, and payees and other accounts are looked up for the page
  only. A search still reads every entry (it matches payees). A test checks that pages, totals
  and date ranges match the full read.
- **One pass for P&L columns.** A P&L by month over three years ran one query per column (37).
  `ledgerNets` reads all the columns in one query, joining a `values` list of date ranges. On
  the cash basis each column also worked out every payment application since the start of the
  books (26 s in all). The recognitions are now worked out once for the whole range and added
  to each column containing their date, which gives the same amounts: a recognition depends
  only on the applications before it. A single period loads the lines only of documents with
  an application in it. Tests check by-month columns against each month run alone.
- **Saving a customer** loaded every customer to build the new one's full name, so creating
  customers got slower as the list grew. It now walks up from the one customer.
- **Sorting names.** `a.localeCompare(b, 'en', options)` builds a collator on every comparison.
  Under load, sorting 5,000 customers and grouping report rows by party took half the API's
  CPU. `common/collate.ts` keeps one collator for each ordering (the same order). Aging works
  out days with integer date arithmetic instead of `Date.parse`.

No new indexes were needed: every slow query was slow for another reason, and the existing
indexes (ADR 0003 and later) cover the lookups.

### Running it in production

- **`DB_POOL_SIZE`** (default 10) sets connections per API or worker process. Keep processes
  times pool size under the database's `max_connections`.
- **`RATE_LIMIT_PER_MINUTE`** (default 600 per client address) is now configuration. The load
  test raises it, since its 50 users share one address.
- **Graceful shutdown:** Nest stops accepting connections on SIGTERM but doesn't wait for
  running requests. The database pool closed under them ("driver has already been destroyed").
  `InflightRequests` (`common/inflight.ts`) counts requests, and shutdown waits up to 25 s for
  them before closing the pool. A request counts until its handler answers (`res.end`), not
  until the client goes away: a client that gives up doesn't stop the handler using the
  database. The orchestrator's stop timeout must be longer (12d).

## Results

Full scale, on the development container (4 vCPUs, 16 GB, Postgres 16 on the same machine). See
`docs/phase-12.md` for the table.

## Consequences

- **The targets are tested:** a change that makes a page much slower fails CI, and the nightly
  run shows the real numbers.
- **Numbers are from one machine** with the database on it. They need repeating on the AWS
  sizes chosen in 12d (question 87).
- **What "50 users" means** here is a modelling choice: people with a few seconds between
  actions, which is busier than real bookkeeping. With no pauses at all, one instance on this
  machine serves about 16 requests a second (question 87).
- **Single-company load:** the load test is 50 users in one company. Many companies on one
  database share its cache and connections. 12d sizes the database for the expected number of
  companies.

## Not in this part

- **Lists that return every row:** the customers list sends all 5,000 customers at once
  (question 88).
- **Larger companies:** past the targets, reports that list every row grow with the data. The
  General Ledger, Journal and transaction detail reports stop at 20,000 rows and say so; the
  aging detail and open invoices reports list every open item, so they grow with what is
  unpaid rather than with history.
- **Caching report results:** not needed at these targets.
