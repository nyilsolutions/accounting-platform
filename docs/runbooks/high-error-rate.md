# High error rate

**Alarms:** `acct-<env>-web-5xx` (server errors at the load balancer), `-api-errors` (error
lines in the API log).

1. **When did it start?** Compare with the last deploy (GitHub Actions > Deploy). If the errors
   started with it, [roll back](rollback.md) first, then investigate.
2. **What is failing?** Use the Logs Insights query in the [README](README.md) on
   `/acct/<env>/api`, grouped by `msg`. Follow one `requestId` through the log.
3. **Common causes:**
   - **Database:** `connection`, `timeout` or `too many clients` errors. See [database](database.md).
   - **A provider is down** (Stripe, Plaid, Intuit, IRS stand-ins, HIBP): the errors name the
     provider. The app fails safe (requests show as unknown or sending and are retried by jobs).
     Check the provider's status page and wait; nothing is guessed.
   - **KMS or S3 access denied:** an IAM or key policy change. Compare with Terraform
     (`terraform plan` should show no changes).
   - **One company or user:** errors share a `companyId` or `userId`. That is likely a data
     problem; open a ticket and avoid hand-editing the books (everything posts through
     `PostingService`).
4. **WAF blocks** look like 403s, not 5xx: check the `aws-waf-logs-acct-<env>` log group for a
   rule that blocks real users (for example the rate limit for an office behind one IP) and
   raise `waf_rate_limit` or add an exception in Terraform.
