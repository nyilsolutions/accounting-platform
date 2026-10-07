-- Phase 12c: retention (ASVS 8.3.8, ADR 0029). Keep secrets and credentials no longer than
-- they are needed.

-- A direct deposit change request needs its encrypted bank numbers only until it is decided:
-- approved ones were copied to the employee's accounts, rejected and withdrawn ones are not
-- used. The summary (masked) stays for the history.
alter table employee_change_requests drop constraint employee_change_requests_check1;
alter table employee_change_requests add constraint employee_change_requests_secret_check
  check (case when status = 'pending' then (kind = 'bank_accounts') = (secret_enc is not null)
              else secret_enc is null end);

create function app_change_request_drop_secret() returns trigger language plpgsql as $$
begin
  if new.status <> 'pending' then new.secret_enc := null; end if;
  return new;
end $$;
create trigger employee_change_requests_drop_secret before update of status
  on employee_change_requests for each row execute function app_change_request_drop_secret();

-- Requests decided before this migration.
update employee_change_requests set secret_enc = null where status <> 'pending';

-- The daily cleanup: sign-in sessions, one-time links and invitations that can no longer be
-- used, 30 days after they ended (kept that long for investigating an incident). Their use is
-- in the audit log, which stays. Returns how many of each went.
create function app_cleanup_expired_credentials(p_now timestamptz)
  returns table (kind text, deleted bigint)
  language plpgsql security definer set search_path = public as $$
declare
  cutoff timestamptz := p_now - interval '30 days';
begin
  return query with d as (
    delete from sessions where coalesce(revoked_at, expires_at) < cutoff returning 1
  ) select 'sessions'::text, count(*) from d;
  return query with d as (
    delete from customer_portal_sessions where coalesce(revoked_at, expires_at) < cutoff
    returning 1
  ) select 'customer_portal_sessions'::text, count(*) from d;
  return query with d as (
    delete from customer_portal_tokens where coalesce(used_at, expires_at) < cutoff returning 1
  ) select 'customer_portal_tokens'::text, count(*) from d;
  return query with d as (
    -- Accepted invitations stay: they record who joined, and when, at whose invitation.
    delete from invitations
     where accepted_at is null and coalesce(revoked_at, expires_at) < cutoff returning 1
  ) select 'invitations'::text, count(*) from d;
end $$;
revoke all on function app_cleanup_expired_credentials(timestamptz) from public;
grant execute on function app_cleanup_expired_credentials(timestamptz) to acct_app;
