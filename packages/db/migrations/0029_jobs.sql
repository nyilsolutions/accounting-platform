-- Phase 12a: a Postgres job queue (pg-boss, ADR 0027) and the lookups its scheduled jobs use.
--
-- pg-boss keeps its tables in their own schema, installed and upgraded by the owner after the
-- migrations (`pnpm db:migrate` runs `jobs:install`), which then grants the app role row access
-- only: acct_app still owns nothing and can't change the schema. The tables hold job names and
-- the ids a job works on, never tenant data, so they are outside RLS.
create schema pgboss;
grant usage on schema pgboss to acct_app;

-- The nightly bank download: active connections not downloaded since p_before, with the
-- company each belongs to (ids only). Each is then synced inside its company with withTenant().
create function app_bank_connections_due(p_before timestamptz)
  returns table (company_id uuid, connection_id uuid)
  language sql stable security definer set search_path = public as $$
    select company_id, id from bank_feed_connections
     where status = 'active' and created_by is not null
       and (last_synced_at is null or last_synced_at < p_before)
     order by last_synced_at nulls first
  $$;
revoke all on function app_bank_connections_due(timestamptz) from public;
grant execute on function app_bank_connections_due(timestamptz) to acct_app;

-- The daily purge: companies with deleted documents whose stored versions aren't purged yet.
-- Whether each is past its company's retention period is decided inside the company.
create function app_documents_purge_candidates() returns setof uuid
  language sql stable security definer set search_path = public as $$
    select distinct d.company_id from documents d
      join document_versions v on v.document_id = d.id
     where d.status = 'deleted' and v.purged_at is null
  $$;
revoke all on function app_documents_purge_candidates() from public;
grant execute on function app_documents_purge_candidates() to acct_app;
