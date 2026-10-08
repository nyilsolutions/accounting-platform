# Runbooks

What to do when something happens in production (ADR 0030). Each CloudWatch alarm's description
names its runbook. Alarms email the alarm topic (`acct-<env>-alarms`); declare an incident under
the incident response plan (`docs/policies/incident-response-plan.md`) whenever customers are
affected or data may be exposed.

| Runbook                                   | Alarms or events                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| [Service down](service-down.md)           | `alb-5xx`, `web-unhealthy`, `api-tasks`, `web-tasks`, `worker-tasks`, task stopped |
| [High error rate](high-error-rate.md)     | `web-5xx`, `api-errors`                                                            |
| [High latency](high-latency.md)           | `latency-p95`, `api-cpu`, `api-memory`                                             |
| [Database](database.md)                   | `db-cpu`, `db-storage`, `db-memory`, `db-connections`, RDS events                  |
| [Jobs](jobs.md)                           | `worker-errors`                                                                    |
| [Mail](mail.md)                           | `ses-bounces`, `ses-complaints`                                                    |
| [Security events](security-events.md)     | `security-events`, GuardDuty findings                                              |
| [Backups](backups.md)                     | AWS Backup job failures, `s3-replication`                                          |
| [Deploy](deploy.md)                       | `release-failed`, a failed deploy workflow                                         |
| [Rollback](rollback.md)                   | A release that has to be undone                                                    |
| [Restore drill](restore-drill.md)         | Quarterly                                                                          |
| [Disaster recovery](disaster-recovery.md) | Loss of the region, the account or the database                                    |
| [Rotate secrets](rotate-secrets.md)       | Yearly, on staff changes, or after a suspected leak                                |

## Getting in

- **Read-only first:** CloudWatch (dashboards, Logs Insights), the ECS console, RDS Performance
  Insights. Logs are JSON: filter by `requestId` (a job's id for job lines), `userId`, `job` or
  `traceId`.
- **Inside a task (break-glass):** `aws ecs execute-command --cluster acct-<env> --task <id>
--container api --interactive --command sh`. Record why in the incident ticket; CloudTrail
  records the session. Never print secrets, SSNs or bank numbers.
- **The database:** there is no public endpoint. Use a one-off task of the release task
  definition (it has the owner's URL) or ECS Exec into an API task; prefer read-only queries.

Useful Logs Insights query (errors in the last hour, by message):

```
fields @timestamp, context, msg, requestId
| filter level = "error"
| stats count() by context, msg
| sort count() desc
```
