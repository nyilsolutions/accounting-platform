# Service down

**Alarms:** `acct-<env>-alb-5xx`, `-web-unhealthy`, `-api-tasks`, `-web-tasks`,
`-worker-tasks`, and "task stopped" events.

1. **Is the site answering?** `curl -sS https://<domain>/healthz` (web only) and
   `https://<domain>/api/health/ready` (API, database and job queue).
2. **ECS console > cluster `acct-<env>`:** for each service, check desired against running, and
   the **Events** tab (failed health checks, image pull errors, out of capacity).
3. **Stopped tasks:** open one and read _Stopped reason_ and the container exit codes.
   - `CannotPullContainerError`: ECR permissions, or the image tag doesn't exist (a bad deploy).
     Redeploy the previous tag ([rollback](rollback.md)).
   - `ResourceInitializationError ... secrets`: a provider secret has no value. Put it in
     Secrets Manager (`acct/<env>/<NAME>`), then force a new deployment.
   - Exit code 1 at start: read the container log. `Invalid configuration ...` or `... in
production` comes from `loadConfig`; fix the setting in Terraform (`app_settings`) and
     apply. `No field encryption keys` means the release step didn't run; run it ([deploy](deploy.md)).
   - `OutOfMemory` or exit 137: see [high latency](high-latency.md) (memory).
4. **API tasks unhealthy, but the database is fine:** clamd may be failing to start (the API
   waits for it). Check the `clamd` container log. It starts from the signatures in its image, so it
   doesn't need the network to start; freshclam's updates need outbound HTTPS.
5. **Only the web is down:** the load balancer target group shows the reason. The web image is
   built for `api.acct.internal`; if Cloud Map has no healthy API records, every `/api` call
   fails.
6. **Still down after 15 minutes:** declare an incident, post a status update, and roll back
   if a deploy happened in the last day.
