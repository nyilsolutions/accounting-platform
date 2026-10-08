# Jobs

**Alarm:** `acct-<env>-worker-errors` (more than 20 error lines from the worker in 5 minutes).

1. **Which job?** Logs Insights on `/acct/<env>/worker`, `filter level = "error" | stats
count() by job, msg` (each line carries the job's name in `job` and its id in `requestId`).
2. **Retries:** each job has its own retry limit with backoff (`jobs/jobs.ts`). A provider
   outage fails jobs until it recovers; they retry by themselves.
3. **Failed for good:** pg-boss keeps failed jobs for 7 days. Inspect them as the owner:
   `select name, state, retry_count, output, created_on from pgboss.job where state = 'failed' order by created_on desc limit 20;`
   Fix the cause, then send the job again from the code path that created it (the job data
   is ids only). Don't edit job rows by hand.
4. **Nothing running at all:** the `worker-tasks` alarm will also fire. See
   [service down](service-down.md). Scheduled jobs (pollers, nightly bank sync, purges,
   reports) catch up on their next run.
5. **Payroll and tax deadlines:** if the EFTPS or deposit partner pollers are failing near a
   pay date or deposit due date, tell the affected companies (their payments may need to be
   made by hand) under the incident plan.
