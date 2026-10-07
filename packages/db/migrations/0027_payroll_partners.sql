-- Phase 11b: EFTPS batch payments and a direct deposit partner (ADR 0025).
--
-- EFTPS: the platform is each company's EFTPS batch provider (a stand-in until enrolled with the
-- Treasury). A company enrolls once with the bank account EFTPS debits; federal tax payments are
-- then scheduled through the provider, recorded in the books when scheduled, and voided
-- automatically if cancelled or returned.
--
-- Direct deposit: each company keeps the NACHA file it uploads to its bank, or sends deposits
-- through the platform's payments partner (a stand-in until one is contracted). Partner deposits
-- are tracked entry by entry; a returned one flags the paycheck and turns the account off.

-- ---------------------------------------------------------------------------------------------
-- EFTPS enrollment
-- ---------------------------------------------------------------------------------------------
create table eftps_enrollments (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies (id) on delete cascade,
  provider         text not null check (length(provider) between 1 and 40),
  -- pending: sent, waiting for the Treasury; enrolled; rejected; cancelled (by the company)
  status           text not null default 'pending'
                   check (status in ('pending', 'enrolled', 'rejected', 'cancelled')),
  -- The provider's id for the enrollment; null until it was received.
  reference        text check (length(reference) between 1 and 60),
  -- The account EFTPS debits (number encrypted, AAD eftps_enrollment:<id>:account_number).
  routing_number   text not null check (routing_number ~ '^\d{9}$'),
  account_enc      text not null,
  account_last4    text not null check (account_last4 ~ '^\d{1,4}$'),
  account_type     text not null check (account_type in ('checking', 'savings')),
  -- Who authorized the debits for the company.
  authorized_name  text not null check (length(authorized_name) between 1 and 80),
  authorized_title text not null check (length(authorized_title) between 1 and 60),
  message          text check (length(message) <= 500),
  created_by       uuid references users (id),
  created_at       timestamptz not null default now(),
  decided_at       timestamptz,
  cancelled_at     timestamptz,
  unique (company_id, id),
  check ((status in ('enrolled', 'rejected')) = (decided_at is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
-- One live enrollment per company.
create unique index eftps_enrollments_live on eftps_enrollments (company_id)
  where status in ('pending', 'enrolled');

-- Federal tax payments scheduled through the batch provider.
alter table payroll_liability_payments
  add column provider text check (length(provider) between 1 and 40),
  -- sending: handed to the provider, no answer yet; scheduled: accepted, settles on the payment
  -- date; settled; returned (the debit failed); cancelled (before settlement); failed (never
  -- scheduled).
  add column eftps_status text check (eftps_status in
    ('sending', 'scheduled', 'settled', 'returned', 'cancelled', 'failed')),
  add column provider_message text check (length(provider_message) <= 500),
  add column status_at timestamptz,
  add constraint payroll_liability_payments_eftps_check
    check ((provider is null) = (eftps_status is null)),
  -- A payment that never happened is void in the books.
  add constraint payroll_liability_payments_eftps_void_check
    check (eftps_status is null or eftps_status not in ('cancelled', 'failed') or status = 'void');

-- ---------------------------------------------------------------------------------------------
-- Direct deposit through a partner
-- ---------------------------------------------------------------------------------------------
alter table payroll_settings
  add column deposit_rail text not null default 'nacha_file'
    check (deposit_rail in ('nacha_file', 'partner'));

alter table ach_batches
  -- nacha_file: a file the employer uploads; partner: sent through the payments partner.
  add column rail text not null default 'nacha_file' check (rail in ('nacha_file', 'partner')),
  add column provider text check (length(provider) between 1 and 40),
  -- Partner batches: sending → submitted → settled, or failed (never sent).
  add column status text not null default 'file'
    check (status in ('file', 'sending', 'submitted', 'settled', 'failed')),
  add column reference text check (length(reference) between 1 and 60),
  add column provider_message text check (length(provider_message) <= 500),
  alter column file_sha256 drop not null,
  add constraint ach_batches_rail_fields_check check (
    (rail = 'nacha_file') = (status = 'file')
    and (rail = 'nacha_file') = (file_sha256 is not null)
    and (rail = 'partner') = (provider is not null)
    and (status in ('submitted', 'settled')) = (reference is not null));

-- One batch per pay run, but a partner batch that failed to send can be sent again.
drop index ach_batches_pay_run_key;
create unique index ach_batches_pay_run_key on ach_batches (pay_run_id)
  where pay_run_id is not null and status <> 'failed';

-- Each entry of a partner batch, so a return can be traced to its paycheck and account.
create table direct_deposit_entries (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null,
  ach_batch_id     uuid not null,
  -- The paycheck it pays (null for a prenote).
  paycheck_id      uuid,
  employee_id      uuid not null,
  -- The employee's account (no foreign key: accounts are replaced when the employee changes them).
  bank_account_id  uuid not null,
  account_last4    text not null check (account_last4 ~ '^\d{1,4}$'),
  amount           numeric(19,4) not null check (amount >= 0),
  prenote          boolean not null default false,
  status           text not null default 'submitted'
                   check (status in ('submitted', 'settled', 'returned')),
  -- The return code the bank gave (e.g. R03) and its reason.
  return_code      text check (return_code ~ '^[A-Z0-9]{1,4}$'),
  return_reason    text check (length(return_reason) <= 200),
  returned_at      timestamptz,
  unique (company_id, id),
  foreign key (company_id, ach_batch_id) references ach_batches (company_id, id),
  foreign key (company_id, employee_id) references employees (company_id, id),
  check ((status = 'returned') = (returned_at is not null and return_code is not null)),
  check (prenote = (paycheck_id is null))
);
create index direct_deposit_entries_batch on direct_deposit_entries (ach_batch_id);
create index direct_deposit_entries_paycheck on direct_deposit_entries (paycheck_id)
  where paycheck_id is not null;

-- An account whose deposit came back is off until it is fixed.
alter table employee_bank_accounts
  add column returned_at timestamptz,
  add column return_reason text check (length(return_reason) <= 200);

do $$
declare t text;
begin
  foreach t in array array['eftps_enrollments', 'direct_deposit_entries'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for all using (company_id = app_current_company_id())
      with check (company_id = app_current_company_id())', t || '_tenant', t);
  end loop;
end $$;
-- Enrollments and deposit entries are kept, never deleted.
grant select, insert, update on eftps_enrollments, direct_deposit_entries to acct_app;
-- Partner batches move from sending to submitted (or failed) and settled; nothing else about a
-- batch ever changes, and NACHA file records stay as created (the rail check keeps them 'file').
grant update (status, reference, provider_message) on ach_batches to acct_app;
create function app_ach_batch_status_guard() returns trigger language plpgsql as $$
begin
  if not (old.status = new.status
          or (old.status = 'sending' and new.status in ('submitted', 'failed'))
          or (old.status = 'submitted' and new.status = 'settled')) then
    raise exception 'A direct deposit batch can''t go from % to %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger ach_batches_status_guard before update on ach_batches
  for each row execute function app_ach_batch_status_guard();

-- The poller works outside any company: it finds what waits on a provider (ids only), then works
-- inside each company with withTenant().
create function app_payroll_partner_waiting(p_eftps text, p_partner text)
  returns table (kind text, company_id uuid, id uuid, reference text)
  language sql stable security definer set search_path = public as $$
    select 'enrollment', company_id, id, reference from eftps_enrollments
     where status = 'pending' and provider = p_eftps and reference is not null
    union all
    select 'payment', company_id, id, reference from payroll_liability_payments
     where eftps_status = 'scheduled' and provider = p_eftps
    union all
    select 'batch', company_id, id, reference from ach_batches
     where status = 'submitted' and provider = p_partner
    limit 2000
  $$;
revoke all on function app_payroll_partner_waiting(text, text) from public;
grant execute on function app_payroll_partner_waiting(text, text) to acct_app;
