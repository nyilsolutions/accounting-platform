-- Phase 0 foundation: identity, sessions, companies (tenants), memberships, invitations, audit log.
--
-- Security model (see docs/adr/0003-tenant-isolation-rls.md):
--   * Migrations run as the schema owner. The API connects as `acct_app`, which does NOT own any
--     table and does NOT have BYPASSRLS, so every tenant-scoped table is filtered by RLS.
--   * Per-transaction context is set with set_config('app.user_id' / 'app.company_id', ..., true).
--   * Identity tables (users, sessions, mfa_recovery_codes) are global, not tenant-scoped.

create function app_current_user_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create function app_current_company_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.company_id', true), '')::uuid $$;

create function app_touch_updated_at() returns trigger
  language plpgsql
  as $$ begin new.updated_at = now(); return new; end $$;

-- ---------------------------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------------------------
create table users (
  id                  uuid primary key default gen_random_uuid(),
  email               text not null check (email = lower(email) and length(email) <= 254),
  full_name           text not null check (length(full_name) between 1 and 200),
  password_hash       text not null,
  mfa_secret_enc      text,
  mfa_enabled_at      timestamptz,
  mfa_last_used_step  bigint,
  failed_login_count  integer not null default 0,
  locked_until        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index users_email_key on users (email);
create trigger users_touch before update on users for each row execute function app_touch_updated_at();

create table mfa_recovery_codes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  code_hash   text not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index mfa_recovery_codes_user_idx on mfa_recovery_codes (user_id);

create table sessions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users (id) on delete cascade,
  token_hash       text not null unique,
  mfa_verified_at  timestamptz,
  ip               text,
  user_agent       text,
  created_at       timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  expires_at       timestamptz not null,
  revoked_at       timestamptz
);
create index sessions_user_idx on sessions (user_id);

-- ---------------------------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------------------------
create table companies (
  id                       uuid primary key default gen_random_uuid(),
  legal_name               text not null check (length(legal_name) between 1 and 200),
  dba_name                 text,
  ein_enc                  text,
  ein_last4                text check (ein_last4 ~ '^\d{4}$'),
  address_line1            text,
  address_line2            text,
  city                     text,
  state                    text check (state ~ '^[A-Z]{2}$'),
  postal_code              text,
  country                  text not null default 'US' check (country ~ '^[A-Z]{2}$'),
  phone                    text,
  email                    text,
  fiscal_year_start_month  smallint not null default 1 check (fiscal_year_start_month between 1 and 12),
  tax_form                 text not null default 'schedule_c'
                             check (tax_form in ('schedule_c','form_1065','form_1120','form_1120s','form_990','other')),
  accounting_basis         text not null default 'accrual' check (accounting_basis in ('accrual','cash')),
  created_by               uuid references users (id),
  updated_by               uuid references users (id),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create trigger companies_touch before update on companies for each row execute function app_touch_updated_at();

create table memberships (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies (id) on delete cascade,
  user_id     uuid not null references users (id) on delete cascade,
  role        text not null check (role in ('owner','admin','accountant','standard','sales','purchases','payroll_admin','time_tracking','reports_only')),
  created_by  uuid references users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, user_id)
);
create index memberships_user_idx on memberships (user_id);
create trigger memberships_touch before update on memberships for each row execute function app_touch_updated_at();

create table invitations (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies (id) on delete cascade,
  email        text not null check (email = lower(email)),
  role         text not null check (role in ('owner','admin','accountant','standard','sales','purchases','payroll_admin','time_tracking','reports_only')),
  token_hash   text not null unique,
  invited_by   uuid references users (id),
  expires_at   timestamptz not null,
  accepted_at  timestamptz,
  accepted_by  uuid references users (id),
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index invitations_company_idx on invitations (company_id);

-- ---------------------------------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------------------------------
create table audit_log (
  id             bigint generated always as identity primary key,
  company_id     uuid references companies (id) on delete restrict,
  actor_user_id  uuid references users (id),
  action         text not null,
  entity_type    text,
  entity_id      text,
  before         jsonb,
  after          jsonb,
  metadata       jsonb,
  ip             text,
  user_agent     text,
  request_id     text,
  created_at     timestamptz not null default now()
);
create index audit_log_company_idx on audit_log (company_id, id desc);
create index audit_log_actor_idx on audit_log (actor_user_id, id desc);

create function app_audit_log_immutable() returns trigger
  language plpgsql
  as $$ begin raise exception 'audit_log is append-only'; end $$;

create trigger audit_log_no_update before update or delete on audit_log
  for each row execute function app_audit_log_immutable();
create trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function app_audit_log_immutable();

-- ---------------------------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------------------------
alter table companies   enable row level security;
alter table memberships enable row level security;
alter table invitations enable row level security;
alter table audit_log   enable row level security;

-- memberships: visible inside the current company, or the current user's own rows (company list).
create policy memberships_select on memberships for select
  using (company_id = app_current_company_id() or user_id = app_current_user_id());
create policy memberships_insert on memberships for insert
  with check (company_id = app_current_company_id());
create policy memberships_update on memberships for update
  using (company_id = app_current_company_id())
  with check (company_id = app_current_company_id());
create policy memberships_delete on memberships for delete
  using (company_id = app_current_company_id());

-- companies: the current company, or any company the current user belongs to (read only).
create policy companies_select on companies for select
  using (
    id = app_current_company_id()
    or exists (select 1 from memberships m where m.company_id = companies.id and m.user_id = app_current_user_id())
  );
create policy companies_insert on companies for insert
  with check (id = app_current_company_id());
create policy companies_update on companies for update
  using (id = app_current_company_id())
  with check (id = app_current_company_id());
-- No delete policy: companies cannot be deleted by the application role.

create policy invitations_all on invitations for all
  using (company_id = app_current_company_id())
  with check (company_id = app_current_company_id());

-- audit_log: company entries inside the company; personal (company-less) entries to their actor.
create policy audit_log_select on audit_log for select
  using (
    company_id = app_current_company_id()
    or (company_id is null and actor_user_id = app_current_user_id())
  );
create policy audit_log_insert on audit_log for insert
  with check (company_id is null or company_id = app_current_company_id());

-- Invitation lookup by token happens before the invitee is a member, so it cannot pass RLS.
-- This narrowly-scoped SECURITY DEFINER function returns only the invitation matching the hash.
create function app_find_invitation(p_token_hash text)
  returns table (id uuid, company_id uuid, company_name text, email text, role text,
                 expires_at timestamptz, accepted_at timestamptz, revoked_at timestamptz)
  language sql stable security definer
  set search_path = public, pg_temp
  as $$
    select i.id, i.company_id, c.legal_name, i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at
    from invitations i join companies c on c.id = i.company_id
    where i.token_hash = p_token_hash
  $$;
revoke all on function app_find_invitation(text) from public;

-- ---------------------------------------------------------------------------------------------
-- Grants for the application role (created by `pnpm db:setup` / infrastructure).
-- ---------------------------------------------------------------------------------------------
grant usage on schema public to acct_app;
grant select, insert, update, delete on users, mfa_recovery_codes, sessions, companies, memberships, invitations to acct_app;
grant select, insert on audit_log to acct_app;
grant execute on function app_find_invitation(text), app_current_user_id(), app_current_company_id() to acct_app;
