-- Phase 7: sales tax, budgets, memorized and scheduled reports.
--
-- Sales tax (ADR 0014):
--   * agencies collect the tax; a rate is either a single rate owed to one agency (its percentage
--     is effective-dated) or a combined rate made of single rates;
--   * sales documents carry the rate applied (transactions.tax_rate_id) and post the tax to Sales
--     Tax Payable through the journal like everything else;
--   * sales_tax_lines is the current-state detail of what each posted transaction did to each
--     agency's liability: tax charged on sales (+), refunded on credits (-), paid (-) or adjusted.
--     The liability report reads only these rows of posted transactions, so it ties to the Sales
--     Tax Payable balance.
-- Budgets hold monthly amounts per account (optionally per class, location or customer).
-- Memorized reports keep a report's settings; a schedule emails it.

-- ---------------------------------------------------------------------------------------------
-- Sales tax agencies and rates
-- ---------------------------------------------------------------------------------------------
create table tax_agencies (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references companies (id) on delete cascade,
  name                 text not null check (length(name) between 1 and 100),
  -- The state or local sales tax account/permit number (not a secret).
  registration_number  text check (length(registration_number) <= 50),
  filing_frequency     text not null default 'quarterly'
                         check (filing_frequency in ('monthly', 'quarterly', 'annually')),
  is_active            boolean not null default true,
  created_by           uuid references users (id),
  updated_by           uuid references users (id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (company_id, id)
);
create unique index tax_agencies_name_key on tax_agencies (company_id, lower(name));
create trigger tax_agencies_touch before update on tax_agencies for each row execute function app_touch_updated_at();

create table tax_rates (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies (id) on delete cascade,
  name         text not null check (length(name) between 1 and 100),
  description  text check (length(description) <= 200),
  kind         text not null check (kind in ('single', 'combined')),
  -- Single rates are owed to one agency; combined rates get theirs from their components.
  agency_id    uuid,
  is_active    boolean not null default true,
  created_by   uuid references users (id),
  updated_by   uuid references users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, agency_id) references tax_agencies (company_id, id),
  check ((kind = 'single') = (agency_id is not null))
);
create unique index tax_rates_name_key on tax_rates (company_id, lower(name));
create trigger tax_rates_touch before update on tax_rates for each row execute function app_touch_updated_at();

-- A single rate's percentage from a date on (rates change; old documents keep theirs).
create table tax_rate_values (
  company_id      uuid not null,
  tax_rate_id     uuid not null,
  effective_from  date not null check (effective_from between '1900-01-01' and '2199-12-31'),
  rate            numeric(9,6) not null check (rate >= 0 and rate <= 100),
  created_by      uuid references users (id),
  created_at      timestamptz not null default now(),
  primary key (tax_rate_id, effective_from),
  foreign key (company_id, tax_rate_id) references tax_rates (company_id, id) on delete cascade
);

create table tax_rate_components (
  company_id    uuid not null,
  combined_id   uuid not null,
  component_id  uuid not null,
  primary key (combined_id, component_id),
  foreign key (company_id, combined_id) references tax_rates (company_id, id) on delete cascade,
  foreign key (company_id, component_id) references tax_rates (company_id, id),
  check (combined_id <> component_id)
);

alter table customers
  add column tax_rate_id           uuid,
  add column tax_exemption_reason  text check (tax_exemption_reason in
    ('resale', 'government', 'nonprofit', 'agriculture', 'manufacturing', 'other')),
  add column tax_exemption_number  text check (length(tax_exemption_number) <= 50),
  add foreign key (company_id, tax_rate_id) references tax_rates (company_id, id);

-- ---------------------------------------------------------------------------------------------
-- Transactions: the rate on sales documents, the agency on payments and adjustments
-- ---------------------------------------------------------------------------------------------
alter table transactions drop constraint transactions_txn_type_check;
alter table transactions add constraint transactions_txn_type_check check (txn_type in (
  'journal_entry', 'invoice', 'sales_receipt', 'credit_memo', 'refund_receipt', 'payment', 'deposit',
  'bill', 'vendor_credit', 'bill_payment', 'check', 'expense', 'cc_credit', 'transfer',
  'sales_tax_payment', 'sales_tax_adjustment'));

alter table transactions
  add column tax_rate_id    uuid,
  add column tax_agency_id  uuid,
  add foreign key (company_id, tax_rate_id) references tax_rates (company_id, id),
  add foreign key (company_id, tax_agency_id) references tax_agencies (company_id, id);
create index transactions_tax_agency_idx on transactions (company_id, tax_agency_id, txn_date)
  where tax_agency_id is not null;

alter table estimates
  add column tax_rate_id  uuid,
  add column tax_total    numeric(19,4) not null default 0 check (tax_total >= 0),
  add foreign key (company_id, tax_rate_id) references tax_rates (company_id, id);

-- What each transaction did to each agency's liability (current state, replaced on save).
create table sales_tax_lines (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  transaction_id  uuid not null,
  line_no         integer not null check (line_no between 1 and 100),
  agency_id       uuid not null,
  -- The single rate charged (sales documents); null on payments and adjustments.
  tax_rate_id     uuid,
  rate            numeric(9,6) check (rate >= 0 and rate <= 100),
  -- Sales the tax was charged on (signed like `amount`), for the liability report.
  taxable_amount  numeric(19,4) not null default 0,
  -- + raises what is owed to the agency, - lowers it.
  amount          numeric(19,4) not null,
  unique (transaction_id, line_no),
  foreign key (company_id, transaction_id) references transactions (company_id, id),
  foreign key (company_id, agency_id) references tax_agencies (company_id, id),
  foreign key (company_id, tax_rate_id) references tax_rates (company_id, id)
);
create index sales_tax_lines_agency_idx on sales_tax_lines (company_id, agency_id);
create index sales_tax_lines_txn_idx on sales_tax_lines (transaction_id);

-- ---------------------------------------------------------------------------------------------
-- Budgets
-- ---------------------------------------------------------------------------------------------
create table budgets (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies (id) on delete cascade,
  name         text not null check (length(name) between 1 and 100),
  -- First day of the budget's first month; a budget covers twelve months.
  start_date   date not null check (extract(day from start_date) = 1),
  -- Amounts per account, or per account and class / location / customer.
  dimension    text not null default 'none' check (dimension in ('none', 'class', 'location', 'customer')),
  created_by   uuid references users (id),
  updated_by   uuid references users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (company_id, id)
);
create unique index budgets_name_key on budgets (company_id, lower(name));
create trigger budgets_touch before update on budgets for each row execute function app_touch_updated_at();

create table budget_amounts (
  company_id    uuid not null,
  budget_id     uuid not null,
  account_id    uuid not null,
  -- The class, location or customer (per the budget's dimension); null = not specified.
  dimension_id  uuid,
  month         smallint not null check (month between 1 and 12),
  amount        numeric(19,4) not null check (amount between -999999999999999 and 999999999999999),
  foreign key (company_id, budget_id) references budgets (company_id, id) on delete cascade,
  foreign key (company_id, account_id) references accounts (company_id, id)
);
create unique index budget_amounts_key on budget_amounts
  (budget_id, account_id, coalesce(dimension_id, '00000000-0000-0000-0000-000000000000'::uuid), month);

-- ---------------------------------------------------------------------------------------------
-- Memorized reports and email schedules
-- ---------------------------------------------------------------------------------------------
create table memorized_reports (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references companies (id) on delete cascade,
  name                text not null check (length(name) between 1 and 100),
  report_key          text not null check (report_key ~ '^[a-z0-9_]{1,60}$'),
  -- Validated settings: relative date range, filters, columns, or a custom report definition.
  params              jsonb not null default '{}',
  -- Shared with everyone in the company who can see reports; otherwise only its creator.
  shared              boolean not null default false,
  schedule_frequency  text check (schedule_frequency in ('daily', 'weekly', 'monthly')),
  -- Weekly: 0 (Sunday) to 6. Monthly: day 1 to 28, or 0 for the last day.
  schedule_day        smallint check (schedule_day between 0 and 28),
  schedule_hour       smallint check (schedule_hour between 0 and 23),
  schedule_timezone   text check (length(schedule_timezone) <= 64),
  recipients          text[] not null default '{}' check (cardinality(recipients) <= 20),
  format              text not null default 'pdf' check (format in ('pdf', 'xlsx', 'csv')),
  next_run_at         timestamptz,
  lease_until         timestamptz,
  last_run_at         timestamptz,
  last_status         text check (last_status in ('sent', 'failed')),
  last_error          text check (length(last_error) <= 1000),
  created_by          uuid not null references users (id),
  updated_by          uuid references users (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (company_id, id),
  check ((schedule_frequency is null) = (next_run_at is null)),
  check (schedule_frequency is null or (schedule_hour is not null and schedule_timezone is not null
         and cardinality(recipients) > 0))
);
create unique index memorized_reports_name_key on memorized_reports (company_id, created_by, lower(name));
create index memorized_reports_due_idx on memorized_reports (next_run_at) where schedule_frequency is not null;
create trigger memorized_reports_touch before update on memorized_reports for each row execute function app_touch_updated_at();

-- The scheduler runs outside any company. This claims the due schedules (a 10-minute lease) and
-- returns only what it needs to then work inside withTenant() as the report's creator.
create function app_claim_report_schedules(p_now timestamptz, p_limit int)
  returns table (report_id uuid, company_id uuid, user_id uuid)
  language sql volatile security definer set search_path = public as $$
    update memorized_reports m
       set lease_until = p_now + interval '10 minutes'
     where m.id in (
       select id from memorized_reports
        where schedule_frequency is not null and next_run_at <= p_now
          and (lease_until is null or lease_until < p_now)
        order by next_run_at
        limit least(greatest(p_limit, 1), 100)
        for update skip locked)
    returning m.id, m.company_id, m.created_by
  $$;
revoke all on function app_claim_report_schedules(timestamptz, int) from public;
grant execute on function app_claim_report_schedules(timestamptz, int) to acct_app;

do $$
declare t text;
begin
  foreach t in array array['tax_agencies', 'tax_rates', 'tax_rate_values', 'tax_rate_components',
                           'sales_tax_lines', 'budgets', 'budget_amounts', 'memorized_reports']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for all using (company_id = app_current_company_id()) with check (company_id = app_current_company_id())',
      t || '_tenant', t);
  end loop;
end $$;

-- Agencies and rates are deactivated, not deleted, once used; sales_tax_lines and budget
-- amounts are replaced on save like other document detail.
grant select, insert, update on tax_agencies, tax_rates to acct_app;
grant select, insert, update, delete on tax_rate_values, tax_rate_components, sales_tax_lines,
  budgets, budget_amounts, memorized_reports to acct_app;
