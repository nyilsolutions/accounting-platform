-- Phase 12c: a company's data export (ADR 0029). The owner asks for an archive of everything
-- (lists, transactions, journal lines, payroll, attached files) as CSV and JSON; a job builds
-- it, stores it encrypted like a document, and it can be downloaded for 7 days.
create table data_exports (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references companies (id) on delete cascade,
  requested_by       uuid not null references users (id),
  -- Full SSNs, EINs, TINs and bank account numbers; otherwise they are masked.
  include_sensitive  boolean not null default false,
  status             text not null default 'pending'
                       check (status in ('pending', 'running', 'ready', 'failed', 'expired')),
  storage_key        text check (length(storage_key) <= 255),
  key_enc            text,
  size_bytes         bigint check (size_bytes >= 0),
  error              text check (length(error) <= 1000),
  created_at         timestamptz not null default now(),
  finished_at        timestamptz,
  expires_at         timestamptz,
  check ((status = 'ready') = (storage_key is not null and expires_at is not null))
);
create index data_exports_company_idx on data_exports (company_id, created_at desc);
-- One at a time per company.
create unique index data_exports_open_key on data_exports (company_id)
  where status in ('pending', 'running');

alter table data_exports enable row level security;
create policy data_exports_tenant on data_exports for all
  using (company_id = app_current_company_id())
  with check (company_id = app_current_company_id());
grant select, insert, update on data_exports to acct_app;

-- The daily cleanup: ready exports past their 7 days, with their company (ids only); each is
-- then deleted from storage and marked expired inside its company.
create function app_data_exports_expired(p_now timestamptz)
  returns table (company_id uuid, export_id uuid)
  language sql stable security definer set search_path = public as $$
    select company_id, id from data_exports where status = 'ready' and expires_at < p_now
  $$;
revoke all on function app_data_exports_expired(timestamptz) from public;
grant execute on function app_data_exports_expired(timestamptz) to acct_app;
