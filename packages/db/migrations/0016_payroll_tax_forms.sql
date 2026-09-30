-- Phase 9: payroll tax forms.
--
--   * Tax lines record the wages subject to the tax before any wage base (subject_wages), so
--     quarterly unemployment reports can show total, excess and taxable wages, and the FUTA
--     summary its wages before the $7,000 limit. Lines written before this migration have none;
--     the forms then use taxable_wages.
--   * Prior payroll: pay from before payroll started here (open question 51), entered as totals
--     per employee and pay date. It counts toward year-to-date wage bases and limits and on the
--     forms, but doesn't post to the books (it is already in them) or add liabilities.
--   * Tax filings: a form marked filed keeps a snapshot of what was filed (never SSNs), so later
--     changes to its period show up as differences needing a correction.
--   * An employee's Treasury tipped occupation code(s) for Form W-2 box 14b.

alter table paycheck_lines add column subject_wages numeric(19,4) check (subject_wages >= 0);

alter table employees add column tipped_occupation_codes text
  check (tipped_occupation_codes ~ '^[0-9]{3}( [0-9]{3})?$');

create table prior_payroll_entries (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies (id) on delete cascade,
  employee_id  uuid not null,
  pay_date     date not null check (pay_date between '1900-01-01' and '2199-12-31'),
  memo         text check (length(memo) <= 200),
  created_by   uuid references users (id),
  updated_by   uuid references users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (company_id, id),
  unique (employee_id, pay_date),
  foreign key (company_id, employee_id) references employees (company_id, id)
);
create trigger prior_payroll_entries_touch before update on prior_payroll_entries
  for each row execute function app_touch_updated_at();

create table prior_payroll_lines (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null,
  entry_id         uuid not null,
  line_no          smallint not null check (line_no between 1 and 500),
  line_type        text not null check (line_type in ('earning', 'deduction', 'contribution', 'tax')),
  payroll_item_id  uuid,
  tax_code         text check (tax_code in (
    'federal_income', 'social_security_employee', 'social_security_employer', 'medicare_employee',
    'medicare_employer', 'additional_medicare', 'futa', 'state_income', 'nyc_income',
    'yonkers_income', 'state_unemployment', 'ny_reemployment_fund', 'ca_ett', 'ca_sdi', 'ny_pfl',
    'ny_dbl')),
  payer            text check (payer in ('employee', 'employer')),
  state            text check (state ~ '^[A-Z]{2}$'),
  amount           numeric(19,4) not null check (amount >= 0),
  taxable_wages    numeric(19,4) check (taxable_wages >= 0),
  subject_wages    numeric(19,4) check (subject_wages >= 0),
  unique (entry_id, line_no),
  foreign key (company_id, entry_id) references prior_payroll_entries (company_id, id)
    on delete cascade,
  foreign key (company_id, payroll_item_id) references payroll_items (company_id, id),
  check ((line_type = 'tax') = (tax_code is not null)),
  check ((line_type = 'tax') = (payer is not null)),
  check ((line_type = 'tax') = (taxable_wages is not null)),
  check ((line_type = 'tax') <> (payroll_item_id is not null))
);

create table tax_filings (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies (id) on delete cascade,
  -- form_941 (a quarter), form_940 (a year), w2 (the year's W-2s and W-3), state_quarterly
  -- (a state's withholding and unemployment reports for a quarter)
  form          text not null check (form in ('form_941', 'form_940', 'w2', 'state_quarterly')),
  tax_year      smallint not null check (tax_year between 2000 and 2199),
  quarter       smallint check (quarter between 1 and 4),
  state         text check (state ~ '^[A-Z]{2}$'),
  filed_on      date not null check (filed_on between '2000-01-01' and '2199-12-31'),
  method        text not null check (method in ('electronic', 'paper', 'provider')),
  confirmation  text check (length(confirmation) <= 60),
  -- The figures as filed (no SSNs).
  snapshot      jsonb not null,
  status        text not null default 'filed' check (status in ('filed', 'void')),
  created_by    uuid references users (id),
  created_at    timestamptz not null default now(),
  voided_by     uuid references users (id),
  voided_at     timestamptz,
  unique (company_id, id),
  check ((form in ('form_941', 'state_quarterly')) = (quarter is not null)),
  check ((form = 'state_quarterly') = (state is not null)),
  check ((status = 'void') = (voided_at is not null))
);
create unique index tax_filings_one_filed on tax_filings
  (company_id, form, tax_year, coalesce(quarter, 0), coalesce(state, ''))
  where status = 'filed';

do $$
declare t text;
begin
  foreach t in array array['prior_payroll_entries', 'prior_payroll_lines', 'tax_filings'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for all using (company_id = app_current_company_id())
      with check (company_id = app_current_company_id())', t || '_tenant', t);
  end loop;
end $$;

-- Prior payroll is entered and corrected until a filing covers it (checked by the service).
grant select, insert, update, delete on prior_payroll_entries, prior_payroll_lines to acct_app;
-- Filings are recorded and voided, never deleted.
grant select, insert, update on tax_filings to acct_app;
