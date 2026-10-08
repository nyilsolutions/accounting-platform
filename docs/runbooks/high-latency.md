# High latency

**Alarms:** `acct-<env>-latency-p95` (p95 over 2 s for 10 minutes), `-api-cpu`, `-api-memory`.

1. **Load or one slow thing?** CloudWatch > the load balancer's `RequestCount` and
   `TargetResponseTime`. A rise in requests with steady per-request time means load. Steady
   requests with slow responses means a slow query or a stuck dependency.
2. **Load:** the API scales on CPU up to `api_max_count`. If it's at the maximum, raise it in
   Terraform (or temporarily: `aws ecs update-service --desired-count`). Check the database
   isn't the limit first ([database](database.md)).
3. **Slow queries:** RDS Performance Insights > top SQL, and the `postgresql` log
   (statements over 1 s are logged). Pages that grow with a company's history must page and
   filter in SQL (ADR 0028); a new report missing that shows here. Reproduce with the perf
   suite (`PERF_SCALE=full`) before fixing.
4. **Memory near 100%:** look for a large export or import in the logs at the same time (data
   exports are built in memory, question 97). Task memory can be raised in
   `modules/platform/ecs.tf`.
5. **Event loop stalls** (CPU high, few requests): a synchronous parser on a large file. Find
   the request in the log by its duration and file type.
