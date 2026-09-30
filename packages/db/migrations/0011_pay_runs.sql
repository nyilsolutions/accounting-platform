-- Phase 8 (part 2): pay runs and paychecks.
--
--   * pay_runs: a batch of paychecks with one pay date (a regular run for a pay schedule's
--     period, or an off-cycle, bonus or final run for chosen employees). Draft, approved, then
--     posted.
--   * paychecks: one employee's pay in a run, with its totals. Posting a paycheck creates a
--     'paycheck' transaction through PostingService (ADR 0007); a posted paycheck is voided,
--     never changed.
--   * paycheck_lines: earnings, deductions, company contributions and taxes. Tax lines keep the
--     taxable wages, so year-to-date wage bases and the liabilities come from here. Lines are
--     replaced while the paycheck is a draft and frozen once it is posted.
--
-- No tax figure is stored as a rule here: tax amounts are what the tax engine calculated from
-- /tax-data (CLAUDE.md rule 7), recorded as facts of the paycheck.

alter table transactions drop constraint transactions_txn_type_check;
alter table transactions add constraint transactions_txn_type_check check (txn_type in (
  'journal_entry', 'invoice', 'sales_receipt', 'credit_memo', 'refund_receipt', 'payment', 'deposit',
  'bill', 'vendor_credit', 'bill_payment', 'check', 'expense', 'cc_credit', 'transfer',
  'sales_tax_payment', 'sales_tax_adjustment', 'paycheck'));

create table pay_runs (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies (id) on delete cascade,
  kind             text not null check (kind in ('regular', 'off_cycle', 'bonus', 'final')),
  -- Regular runs pay one period of one schedule; the others may have neither.
  pay_schedule_id  uuid,
  period_start     date check (period_start between '1900-01-01' and '2199-12-31'),
  period_end       date check (period_end between '1900-01-01' and '2199-12-31'),
  pay_date         date not null check (pay_date between '1900-01-01' and '2199-12-31'),
  -- The pay frequency used for withholding (the schedule's, or chosen for an off-cycle run).
  frequency        text not null check (frequency in ('weekly', 'biweekly', 'semimonthly', 'monthly')),
  status           text not null default 'draft' check (status in ('draft', 'approved', 'posted')),
  memo             text check (length(memo) <= 500),
  approved_by      uuid references users (id),
  approved_at      timestamptz,
  posted_by        uuid references users (id),
  posted_at        timestamptz,
  created_by       uuid references users (id),
  updated_by       uuid references users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, pay_schedule_id) references pay_schedules (company_id, id),
  check (kind <> 'regular' or (pay_schedule_id is not null and period_start is not null and period_end is not null)),
  check (period_end is null or period_start <= period_end),
  check ((status in ('approved', 'posted')) = (approved_at is not null)),
  check ((status = 'posted') = (posted_at is not null))
);
-- One regular run per schedule period.
create unique index pay_runs_regular_period_key on pay_runs (company_id, pay_schedule_id, period_end)
  where kind = 'regular';
create index pay_runs_company_date_idx on pay_runs (company_id, pay_date desc);
create trigger pay_runs_touch before update on pay_runs for each row execute function app_touch_updated_at();

create table paychecks (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null,
  pay_run_id           uuid not null,
  employee_id          uuid not null,
  pay_date             date not null,
  pay_method           text not null check (pay_method in ('check', 'direct_deposit')),
  -- Supplemental wages paid separately (bonus runs): income tax at the flat supplemental rates.
  supplemental         boolean not null default false,
  status               text not null default 'draft' check (status in ('draft', 'posted', 'void')),
  -- Why the tax engine could not calculate this paycheck (reasons as text); null when it could.
  problems             jsonb,
  -- Notices for the payroll admin (e.g. no Form W-4 on file).
  notices              jsonb not null default '[]',
  gross_pay            numeric(19,4) not null default 0,
  employee_taxes       numeric(19,4) not null default 0,
  deductions           numeric(19,4) not null default 0,
  net_pay              numeric(19,4) not null default 0,
  employer_taxes       numeric(19,4) not null default 0,
  contributions        numeric(19,4) not null default 0,
  -- What the payroll admin entered: earnings, and deduction and contribution amounts that
  -- replace or add to the employee's recurring items. Recalculating starts from this.
  input                jsonb not null default '{}',
  -- Where net pay was deposited (bank account ids, last four digits, amounts), fixed at posting.
  deposits             jsonb not null default '[]',
  -- The certificates the taxes were figured from, and the tax-data year.
  w4_id                uuid references employee_w4 (id),
  state_certificate_id uuid references employee_state_certificates (id),
  tax_year             smallint not null,
  transaction_id       uuid,
  voided_by            uuid references users (id),
  voided_at            timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (company_id, id),
  unique (pay_run_id, employee_id),
  foreign key (company_id, pay_run_id) references pay_runs (company_id, id),
  foreign key (company_id, employee_id) references employees (company_id, id),
  foreign key (company_id, transaction_id) references transactions (company_id, id),
  check ((status = 'draft') = (transaction_id is null)),
  check ((status = 'void') = (voided_at is not null)),
  check (status = 'draft' or problems is null),
  check (net_pay >= 0)
);
create index paychecks_employee_idx on paychecks (company_id, employee_id, pay_date);
create trigger paychecks_touch before update on paychecks for each row execute function app_touch_updated_at();

create table paycheck_lines (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null,
  paycheck_id      uuid not null,
  line_no          smallint not null check (line_no between 1 and 500),
  line_type        text not null check (line_type in ('earning', 'deduction', 'contribution', 'tax')),
  -- Earnings, deductions and contributions name their payroll item.
  payroll_item_id  uuid,
  -- Taxes: the tax (tax engine code), who pays it, and the state for state and local taxes.
  tax_code         text check (tax_code in (
    'federal_income', 'social_security_employee', 'social_security_employer', 'medicare_employee',
    'medicare_employer', 'additional_medicare', 'futa', 'state_income', 'nyc_income',
    'yonkers_income', 'state_unemployment', 'ny_reemployment_fund', 'ca_ett', 'ca_sdi')),
  payer            text check (payer in ('employee', 'employer')),
  state            text check (state ~ '^[A-Z]{2}$'),
  hours            numeric(9,2) check (hours >= 0 and hours <= 9999),
  rate             numeric(19,4) check (rate >= 0),
  amount           numeric(19,4) not null check (amount >= 0),
  taxable_wages    numeric(19,4) check (taxable_wages >= 0),
  description      text check (length(description) <= 200),
  unique (paycheck_id, line_no),
  foreign key (company_id, paycheck_id) references paychecks (company_id, id) on delete cascade,
  foreign key (company_id, payroll_item_id) references payroll_items (company_id, id),
  check ((line_type = 'tax') = (tax_code is not null)),
  check ((line_type = 'tax') = (payer is not null)),
  check ((line_type = 'tax') = (taxable_wages is not null)),
  check ((line_type = 'tax') <> (payroll_item_id is not null))
);
create index paycheck_lines_tax_idx on paycheck_lines (company_id, tax_code) where line_type = 'tax';

-- Lines of a posted or voided paycheck are the record: they cannot change.
create function paycheck_lines_frozen() returns trigger language plpgsql as $$
declare pc_id uuid := coalesce(new.paycheck_id, old.paycheck_id);
begin
  if exists (select 1 from paychecks where id = pc_id and status <> 'draft') then
    raise exception 'The lines of a posted paycheck cannot change' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;
create trigger paycheck_lines_frozen before insert or update or delete on paycheck_lines
  for each row execute function paycheck_lines_frozen();

-- A paycheck's amounts cannot change once posted; only its status moves to void.
create function paychecks_frozen() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'A posted paycheck cannot be deleted; void it' using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.status <> 'draft' and (
       new.gross_pay, new.employee_taxes, new.deductions, new.net_pay, new.employer_taxes,
       new.contributions, new.employee_id, new.pay_date, new.pay_run_id)
     is distinct from (
       old.gross_pay, old.employee_taxes, old.deductions, old.net_pay, old.employer_taxes,
       old.contributions, old.employee_id, old.pay_date, old.pay_run_id) then
    raise exception 'A posted paycheck cannot change' using errcode = 'check_violation';
  end if;
  if old.status = 'void' and new.status <> 'void' then
    raise exception 'A voided paycheck stays void' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger paychecks_frozen before update or delete on paychecks
  for each row execute function paychecks_frozen();

create function pay_runs_posted_kept() returns trigger language plpgsql as $$
begin
  if old.status = 'posted' then
    raise exception 'A posted pay run cannot be deleted' using errcode = 'check_violation';
  end if;
  return old;
end $$;
create trigger pay_runs_posted_kept before delete on pay_runs
  for each row execute function pay_runs_posted_kept();

-- A payroll direct deposit file belongs to its pay run (one per run).
alter table ach_batches add column pay_run_id uuid,
  add foreign key (company_id, pay_run_id) references pay_runs (company_id, id),
  add check ((kind = 'payroll') = (pay_run_id is not null));
create unique index ach_batches_pay_run_key on ach_batches (pay_run_id) where pay_run_id is not null;

do $$
declare t text;
begin
  foreach t in array array['pay_runs', 'paychecks', 'paycheck_lines']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for all using (company_id = app_current_company_id()) with check (company_id = app_current_company_id())',
      t || '_tenant', t);
  end loop;
end $$;

-- Draft runs and paychecks can be deleted; posted ones are voided. Lines are replaced while
-- the paycheck is a draft (the trigger freezes them after).
grant select, insert, update, delete on pay_runs, paychecks to acct_app;
grant select, insert, delete on paycheck_lines to acct_app;
