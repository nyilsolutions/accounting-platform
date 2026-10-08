# Database

**Alarms:** `acct-<env>-db-cpu`, `-db-storage`, `-db-memory`, `-db-connections`, and RDS
events (failover, failure, low storage, maintenance).

- **Failover** (RDS event "Multi-AZ failover"): the standby takes over in 1 to 2 minutes and
  the DNS name stays the same. The API reconnects; requests during the switch fail and jobs
  retry. Check `/api/health/ready` afterwards. Nothing else to do unless failovers repeat.
- **CPU:** Performance Insights > top SQL by load. A query that suddenly got slow after a
  deploy: [roll back](rollback.md). Sustained growth: a bigger instance class
  (`db_instance_class`, applied in the maintenance window or with a planned failover).
- **Storage:** storage grows on its own up to `db_max_allocated_storage`. If the alarm fires
  near that limit, raise it in Terraform. Look for unexpected growth first (a job writing in a
  loop, the pg-boss archive): `select relname, pg_size_pretty(pg_total_relation_size(oid)) from pg_class order by pg_total_relation_size(oid) desc limit 20;`
- **Connections:** each API and worker task opens up to `DB_POOL_SIZE` (10). Tasks times 10
  should stay well under `max_connections`. A spike with errors means leaked connections or a
  stuck transaction: `select pid, state, now() - xact_start, left(query, 80) from pg_stat_activity where state <> 'idle' order by 3 desc;`
  Sessions idle in a transaction are ended after 60 s.
- **Restoring data:** never restore over the live database. Restore a copy (as in the
  [restore drill](restore-drill.md), with `KEEP=1`) and copy what's needed through the
  services, recorded in an incident.
