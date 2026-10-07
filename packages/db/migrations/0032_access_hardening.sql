-- Phase 12c: access control fixes from the ASVS Level 2 review (ADR 0029).

-- Desktop agent pairing keys: also return the role the key's creator has in the company now
-- (null when they are no longer a member). The API refuses the key unless that role may manage
-- migrations, so removing someone (or lowering their role) ends their keys at once.
drop function app_migration_agent_key(text);
create function app_migration_agent_key(p_hash text)
  returns table (key_id uuid, company_id uuid, migration_id uuid, user_id uuid, role text)
  language sql stable security definer set search_path = public as $$
    select k.id, k.company_id, k.migration_id, k.created_by, m.role
    from migration_agent_keys k
    left join memberships m on m.company_id = k.company_id and m.user_id = k.created_by
    where k.key_hash = p_hash and k.revoked_at is null and k.expires_at > now()
  $$;
revoke all on function app_migration_agent_key(text) from public;
grant execute on function app_migration_agent_key(text) to acct_app;

-- Customer portal links and sessions only work for active customers.
create or replace function app_customer_portal_token(p_token_hash text)
  returns table (id uuid, company_id uuid, customer_id uuid, expires_at timestamptz,
                 used_at timestamptz)
  language sql stable security definer set search_path = public as $$
    select t.id, t.company_id, t.customer_id, t.expires_at, t.used_at
    from customer_portal_tokens t
    join customers c on c.company_id = t.company_id and c.id = t.customer_id and c.is_active
    where t.token_hash = p_token_hash
  $$;

create or replace function app_customer_portal_session(p_token_hash text)
  returns table (id uuid, company_id uuid, customer_id uuid, expires_at timestamptz,
                 last_seen_at timestamptz, revoked_at timestamptz)
  language sql stable security definer set search_path = public as $$
    select s.id, s.company_id, s.customer_id, s.expires_at, s.last_seen_at, s.revoked_at
    from customer_portal_sessions s
    join customers c on c.company_id = s.company_id and c.id = s.customer_id and c.is_active
    where s.token_hash = p_token_hash
  $$;

-- When a customer's email changes or the customer is made inactive, links already sent and
-- sessions already open stop working: they belonged to the old address or contact.
create function customers_end_portal_access() returns trigger
  language plpgsql as $$
begin
  if new.email is distinct from old.email or (old.is_active and not new.is_active) then
    update customer_portal_tokens set expires_at = now()
     where company_id = new.company_id and customer_id = new.id
       and used_at is null and expires_at > now();
    update customer_portal_sessions set revoked_at = now()
     where company_id = new.company_id and customer_id = new.id and revoked_at is null;
  end if;
  return new;
end $$;

create trigger customers_end_portal_access
  after update of email, is_active on customers
  for each row execute function customers_end_portal_access();
