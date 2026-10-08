-- Phase 10f: portals for customers, employees and contractors (ADR 0023).
--
--   * portal_links: an employee or contractor (vendor) given portal access. The person signs in
--     with a normal user account (password + MFA) but has no company membership: the link lets
--     them see only their own pay, time and tax forms. A link starts as an invitation (a hashed
--     token emailed to them) and is claimed by the user who accepts it.
--   * employee_change_requests: W-4 and direct deposit changes asked for in the portal. A payroll
--     admin approves them (then they are applied through the normal payroll services) or rejects
--     them. Bank account numbers in a request are encrypted (row-bound AAD), never stored plain.
--   * customer_portal_tokens / customer_portal_sessions: customers sign in with a one-time link
--     emailed to them (15 minutes, single use), which opens a session for that one customer.

create table portal_links (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies (id) on delete cascade,
  kind         text not null check (kind in ('employee', 'contractor')),
  employee_id  uuid,
  vendor_id    uuid,
  email        text not null check (length(email) between 3 and 320),
  -- The invitation: only the SHA-256 of the emailed token.
  token_hash   text unique check (length(token_hash) = 64),
  expires_at   timestamptz not null,
  invited_by   uuid references users (id),
  created_at   timestamptz not null default now(),
  user_id      uuid references users (id),
  accepted_at  timestamptz,
  revoked_at   timestamptz,
  foreign key (company_id, employee_id) references employees (company_id, id),
  foreign key (company_id, vendor_id) references vendors (company_id, id),
  check ((kind = 'employee') = (employee_id is not null)),
  check ((kind = 'contractor') = (vendor_id is not null)),
  check ((accepted_at is null) = (user_id is null))
);
-- One live link (invited or accepted) per employee and per contractor.
create unique index portal_links_employee_key on portal_links (company_id, employee_id)
  where revoked_at is null and employee_id is not null;
create unique index portal_links_vendor_key on portal_links (company_id, vendor_id)
  where revoked_at is null and vendor_id is not null;
-- A person has one live link per company (as an employee or as a contractor).
create unique index portal_links_user_key on portal_links (company_id, user_id)
  where revoked_at is null and user_id is not null;

create table employee_change_requests (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies (id) on delete cascade,
  employee_id     uuid not null,
  kind            text not null check (kind in ('w4', 'bank_accounts')),
  -- What reviewers and the employee see (bank numbers masked).
  summary         jsonb not null,
  -- W-4 requests: the certificate as entered (no secrets).
  payload         jsonb,
  -- Direct deposit requests: the accounts as entered, encrypted.
  secret_enc      text,
  status          text not null default 'pending'
                    check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  requested_by    uuid references users (id),
  requested_at    timestamptz not null default now(),
  decided_by      uuid references users (id),
  decided_at      timestamptz,
  decision_note   text check (length(decision_note) <= 1000),
  foreign key (company_id, employee_id) references employees (company_id, id),
  check ((kind = 'w4') = (payload is not null)),
  check ((kind = 'bank_accounts') = (secret_enc is not null)),
  check ((status = 'pending') = (decided_at is null))
);
-- One open request of each kind per employee.
create unique index employee_change_requests_open_key
  on employee_change_requests (company_id, employee_id, kind) where status = 'pending';

create table customer_portal_tokens (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies (id) on delete cascade,
  customer_id  uuid not null,
  token_hash   text not null unique check (length(token_hash) = 64),
  expires_at   timestamptz not null,
  used_at      timestamptz,
  created_at   timestamptz not null default now(),
  foreign key (company_id, customer_id) references customers (company_id, id)
);

create table customer_portal_sessions (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies (id) on delete cascade,
  customer_id   uuid not null,
  token_hash    text not null unique check (length(token_hash) = 64),
  expires_at    timestamptz not null,
  last_seen_at  timestamptz not null default now(),
  revoked_at    timestamptz,
  ip            inet,
  user_agent    text check (length(user_agent) <= 500),
  created_at    timestamptz not null default now(),
  foreign key (company_id, customer_id) references customers (company_id, id)
);

do $$
declare t text;
begin
  foreach t in array array['portal_links', 'employee_change_requests', 'customer_portal_tokens',
                           'customer_portal_sessions']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for all using (company_id = app_current_company_id()) with check (company_id = app_current_company_id())',
      t || '_tenant', t);
  end loop;
end $$;
grant select, insert, update on portal_links, employee_change_requests, customer_portal_tokens,
  customer_portal_sessions to acct_app;

-- Portal requests arrive without a company: these return ids (and names to show) and nothing
-- else, so the API can then work inside withTenant().

-- An employee or contractor invitation by its token.
create function app_find_portal_invite(p_token_hash text)
  returns table (id uuid, company_id uuid, company_name text, email text, kind text,
                 worker_name text, expires_at timestamptz, accepted_at timestamptz,
                 revoked_at timestamptz)
  language sql stable security definer set search_path = public as $$
    select l.id, l.company_id, coalesce(c.dba_name, c.legal_name), l.email, l.kind,
           coalesce(e.first_name || ' ' || e.last_name, v.display_name),
           l.expires_at, l.accepted_at, l.revoked_at
    from portal_links l
    join companies c on c.id = l.company_id
    left join employees e on e.id = l.employee_id
    left join vendors v on v.id = l.vendor_id
    where l.token_hash = p_token_hash
  $$;
revoke all on function app_find_portal_invite(text) from public;
grant execute on function app_find_portal_invite(text) to acct_app;

-- The companies where a user has portal access.
create function app_portal_links_for_user(p_user_id uuid)
  returns table (id uuid, company_id uuid, company_name text, kind text, employee_id uuid,
                 vendor_id uuid, worker_name text)
  language sql stable security definer set search_path = public as $$
    select l.id, l.company_id, coalesce(c.dba_name, c.legal_name), l.kind, l.employee_id,
           l.vendor_id, coalesce(e.first_name || ' ' || e.last_name, v.display_name)
    from portal_links l
    join companies c on c.id = l.company_id
    left join employees e on e.id = l.employee_id
    left join vendors v on v.id = l.vendor_id
    where l.user_id = p_user_id and l.revoked_at is null
    order by 3
  $$;
revoke all on function app_portal_links_for_user(uuid) from public;
grant execute on function app_portal_links_for_user(uuid) to acct_app;

-- Active customers with an email, across companies (to email them sign-in links).
create function app_customers_by_email(p_email text)
  returns table (company_id uuid, customer_id uuid, company_name text, customer_name text)
  language sql stable security definer set search_path = public as $$
    select cu.company_id, cu.id, coalesce(c.dba_name, c.legal_name), cu.display_name
    from customers cu
    join companies c on c.id = cu.company_id
    where lower(cu.email) = lower(p_email) and cu.is_active
    order by 3, 4
    limit 20
  $$;
revoke all on function app_customers_by_email(text) from public;
grant execute on function app_customers_by_email(text) to acct_app;

-- A customer sign-in link by its token.
create function app_customer_portal_token(p_token_hash text)
  returns table (id uuid, company_id uuid, customer_id uuid, expires_at timestamptz,
                 used_at timestamptz)
  language sql stable security definer set search_path = public as $$
    select id, company_id, customer_id, expires_at, used_at
    from customer_portal_tokens where token_hash = p_token_hash
  $$;
revoke all on function app_customer_portal_token(text) from public;
grant execute on function app_customer_portal_token(text) to acct_app;

-- A customer portal session by its cookie token.
create function app_customer_portal_session(p_token_hash text)
  returns table (id uuid, company_id uuid, customer_id uuid, expires_at timestamptz,
                 last_seen_at timestamptz, revoked_at timestamptz)
  language sql stable security definer set search_path = public as $$
    select id, company_id, customer_id, expires_at, last_seen_at, revoked_at
    from customer_portal_sessions where token_hash = p_token_hash
  $$;
revoke all on function app_customer_portal_session(text) from public;
grant execute on function app_customer_portal_session(text) to acct_app;
