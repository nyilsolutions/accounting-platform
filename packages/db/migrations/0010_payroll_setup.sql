-- Phase 8 (part 1): payroll setup and employees. Nothing here computes a tax: rates, wage bases and
-- tables come from /tax-data/<year>/ (CLAUDE.md rule 7). What is stored here is what the employer
-- and employees tell us: registrations, their own unemployment rates, schedules, certificates.
--
--   * payroll_settings: one row per company that runs payroll (federal return, deposit schedule,
--     default accounts, direct deposit origination details);
--   * pay_schedules, state registrations with each year's unemployment rate, workers' comp
--     classes, PTO policies and payroll items (earnings, deductions, employer contributions);
--   * employees, with their SSN encrypted, their Form W-4 and state withholding certificates as
--     effective-dated history, direct deposit accounts (account numbers encrypted), recurring
--     earnings and deductions, and PTO balances;
--   * ach_batches records every direct deposit file generated (not its contents).

-- ---------------------------------------------------------------------------------------------
-- Company payroll settings
-- ---------------------------------------------------------------------------------------------
create table payroll_settings (
  company_id               uuid primary key references companies (id) on delete cascade,
  -- Form 941 (quarterly) unless the IRS told the employer to file Form 944 (annual).
  federal_form             text not null default '941' check (federal_form in ('941', '944')),
  deposit_schedule         text not null default 'monthly' check (deposit_schedule in ('monthly', 'semiweekly')),
  -- The first pay date run here; earlier pay for the year comes in as prior payroll.
  payroll_start_date       date check (payroll_start_date between '1900-01-01' and '2199-12-31'),
  -- Default accounts. Payroll items may name their own.
  wage_expense_account_id  uuid not null,
  tax_expense_account_id   uuid not null,
  liability_account_id     uuid not null,
  -- The bank account paychecks and direct deposits are paid from.
  bank_account_id          uuid,
  -- Direct deposit origination (NACHA): the bank (ODFI) and the company as the bank knows it.
  ach_odfi_routing         text check (ach_odfi_routing ~ '^\d{9}$'),
  ach_odfi_name            text check (length(ach_odfi_name) between 1 and 23),
  ach_company_name         text check (length(ach_company_name) between 1 and 16),
  -- The company identification the bank assigned; when empty, '1' followed by the EIN.
  ach_company_id           text check (ach_company_id ~ '^[0-9A-Za-z ]{10}$'),
  created_by               uuid references users (id),
  updated_by               uuid references users (id),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  foreign key (company_id, wage_expense_account_id) references accounts (company_id, id),
  foreign key (company_id, tax_expense_account_id) references accounts (company_id, id),
  foreign key (company_id, liability_account_id) references accounts (company_id, id),
  foreign key (company_id, bank_account_id) references accounts (company_id, id)
);
create trigger payroll_settings_touch before update on payroll_settings for each row execute function app_touch_updated_at();

create table pay_schedules (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references companies (id) on delete cascade,
  name                text not null check (length(name) between 1 and 60),
  frequency           text not null check (frequency in ('weekly', 'biweekly', 'semimonthly', 'monthly')),
  -- The end of one pay period; the others follow from the frequency. Semimonthly periods end on
  -- the 15th and the last day of the month.
  first_period_end    date not null check (first_period_end between '1900-01-01' and '2199-12-31'),
  -- Pay date = period end + this many days (moved back to a weekday).
  pay_date_offset     smallint not null default 0 check (pay_date_offset between 0 and 30),
  is_active           boolean not null default true,
  created_by          uuid references users (id),
  updated_by          uuid references users (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (company_id, id),
  check (frequency <> 'semimonthly' or extract(day from first_period_end) = 15
         or extract(day from first_period_end + 1) = 1)
);
create unique index pay_schedules_name_key on pay_schedules (company_id, lower(name));
create trigger pay_schedules_touch before update on pay_schedules for each row execute function app_touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- State registrations and the employer's own rates
-- ---------------------------------------------------------------------------------------------
create table payroll_state_registrations (
  id                           uuid primary key default gen_random_uuid(),
  company_id                   uuid not null references companies (id) on delete cascade,
  state                        text not null check (state ~ '^[A-Z]{2}$'),
  -- Account numbers the states assign (not secrets). States without income tax have none.
  withholding_account_number   text check (length(withholding_account_number) between 1 and 30),
  unemployment_account_number  text check (length(unemployment_account_number) between 1 and 30),
  is_active                    boolean not null default true,
  created_by                   uuid references users (id),
  updated_by                   uuid references users (id),
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, state)
);
create trigger payroll_state_registrations_touch before update on payroll_state_registrations for each row execute function app_touch_updated_at();

-- The employer's unemployment rate for a calendar year, from the state's annual rate notice.
create table state_unemployment_rates (
  company_id       uuid not null,
  registration_id  uuid not null,
  year             smallint not null check (year between 2000 and 2199),
  -- Percent of taxable wages, e.g. 2.7000.
  rate             numeric(7,4) not null check (rate >= 0 and rate <= 25),
  created_by       uuid references users (id),
  created_at       timestamptz not null default now(),
  primary key (registration_id, year),
  foreign key (company_id, registration_id) references payroll_state_registrations (company_id, id) on delete cascade
);

-- Workers' compensation classes from the employer's policy (rate per $100 of wages).
create table workers_comp_classes (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies (id) on delete cascade,
  state        text not null check (state ~ '^[A-Z]{2}$'),
  code         text not null check (length(code) between 1 and 10),
  description  text not null check (length(description) between 1 and 100),
  rate         numeric(9,4) not null check (rate >= 0 and rate <= 100),
  is_active    boolean not null default true,
  created_by   uuid references users (id),
  updated_by   uuid references users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (company_id, id)
);
create unique index workers_comp_classes_code_key on workers_comp_classes (company_id, state, lower(code));
create trigger workers_comp_classes_touch before update on workers_comp_classes for each row execute function app_touch_updated_at();

create table pto_policies (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies (id) on delete cascade,
  name             text not null check (length(name) between 1 and 60),
  kind             text not null check (kind in ('vacation', 'sick', 'personal', 'other')),
  -- none: balance changes only by hand; per_hour_worked: hours earned per hour worked;
  -- per_pay_period: hours per paycheck; annual: hours granted at the start of each year.
  accrual_method   text not null check (accrual_method in ('none', 'per_hour_worked', 'per_pay_period', 'annual')),
  accrual_rate     numeric(9,4) not null default 0 check (accrual_rate >= 0 and accrual_rate <= 9999),
  max_balance      numeric(9,2) check (max_balance >= 0),
  carryover_limit  numeric(9,2) check (carryover_limit >= 0),
  is_active        boolean not null default true,
  created_by       uuid references users (id),
  updated_by       uuid references users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (company_id, id)
);
create unique index pto_policies_name_key on pto_policies (company_id, lower(name));
create trigger pto_policies_touch before update on pto_policies for each row execute function app_touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Payroll items. Taxability is not stored: it follows from the kind and the year's tax data.
-- ---------------------------------------------------------------------------------------------
create table payroll_items (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references companies (id) on delete cascade,
  name                  text not null check (length(name) between 1 and 60),
  kind                  text not null check (kind in (
    -- earnings
    'hourly', 'overtime', 'double_time', 'salary', 'bonus', 'commission', 'cash_tips',
    'paid_tips', 'vacation', 'sick', 'holiday', 'reimbursement', 'fringe_benefit', 'other_earning',
    -- pre-tax deductions
    'traditional_401k', 'traditional_403b', 'section_125', 'hsa', 'health_fsa',
    'dependent_care_fsa',
    -- post-tax deductions
    'roth_401k', 'roth_403b', 'garnishment', 'loan_repayment', 'other_deduction',
    -- employer contributions
    'retirement_match', 'employer_health', 'employer_hsa', 'other_employer_contribution')),
  -- Overtime and double time: the multiple of the regular rate.
  rate_multiplier       numeric(6,4) check (rate_multiplier > 0 and rate_multiplier <= 10),
  -- Paid time off drawn from a policy's balance.
  pto_policy_id         uuid,
  garnishment_type      text check (garnishment_type in
    ('child_support', 'creditor', 'federal_tax_levy', 'state_tax_levy', 'student_loan', 'bankruptcy', 'other')),
  -- Where earnings and employer contributions are expensed, and where withheld or owed amounts
  -- are held; null uses the payroll settings' defaults.
  expense_account_id    uuid,
  liability_account_id  uuid,
  -- Who deductions and contributions are paid to (a 401(k) provider, a child support agency).
  vendor_id             uuid,
  is_active             boolean not null default true,
  created_by            uuid references users (id),
  updated_by            uuid references users (id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, pto_policy_id) references pto_policies (company_id, id),
  foreign key (company_id, expense_account_id) references accounts (company_id, id),
  foreign key (company_id, liability_account_id) references accounts (company_id, id),
  foreign key (company_id, vendor_id) references vendors (company_id, id),
  check ((kind = 'garnishment') = (garnishment_type is not null)),
  check (rate_multiplier is null or kind in ('overtime', 'double_time')),
  check (pto_policy_id is null or kind in ('vacation', 'sick', 'holiday', 'other_earning'))
);
create unique index payroll_items_name_key on payroll_items (company_id, lower(name));
create trigger payroll_items_touch before update on payroll_items for each row execute function app_touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Employees
-- ---------------------------------------------------------------------------------------------
create table employees (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references companies (id) on delete cascade,
  employee_number        text check (length(employee_number) between 1 and 20),
  first_name             text not null check (length(first_name) between 1 and 50),
  middle_name            text check (length(middle_name) <= 50),
  last_name              text not null check (length(last_name) between 1 and 50),
  suffix                 text check (length(suffix) <= 10),
  -- Encrypted with FieldEncryptor, AAD employee:<id>:ssn. Never logged or audited.
  ssn_enc                text,
  ssn_last4              text check (ssn_last4 ~ '^\d{4}$'),
  date_of_birth          date check (date_of_birth between '1900-01-01' and '2199-12-31'),
  email                  text check (length(email) <= 200),
  phone                  text check (length(phone) <= 40),
  -- Where the employee lives (resident taxes, e.g. New York City and Yonkers).
  address_line1          text check (length(address_line1) <= 200),
  address_line2          text check (length(address_line2) <= 200),
  city                   text check (length(city) <= 100),
  state                  text check (state ~ '^[A-Z]{2}$'),
  postal_code            text check (postal_code ~ '^\d{5}(-\d{4})?$'),
  -- Where the employee works (the state that taxes the wages; the MCTMT district).
  work_address_line1     text check (length(work_address_line1) <= 200),
  work_city              text check (length(work_city) <= 100),
  work_state             text not null check (work_state ~ '^[A-Z]{2}$'),
  work_postal_code       text check (work_postal_code ~ '^\d{5}(-\d{4})?$'),
  hire_date              date not null check (hire_date between '1900-01-01' and '2199-12-31'),
  termination_date       date,
  termination_reason     text check (length(termination_reason) <= 200),
  pay_type               text not null check (pay_type in ('hourly', 'salary', 'commission')),
  -- Hourly: the hourly rate. Salary: the annual salary. Commission only: zero.
  pay_rate               numeric(19,4) not null default 0 check (pay_rate >= 0 and pay_rate <= 99999999),
  -- Hours a regular paycheck starts with (hourly), or the hours a salary covers (for PTO).
  default_hours          numeric(7,2) check (default_hours >= 0 and default_hours <= 744),
  pay_schedule_id        uuid not null,
  pay_method             text not null default 'check' check (pay_method in ('check', 'direct_deposit')),
  -- Not owed overtime under the FLSA (the employer decides; we only record it).
  overtime_exempt        boolean not null default false,
  workers_comp_class_id  uuid,
  class_id               uuid,
  location_id            uuid,
  notes                  text check (length(notes) <= 4000),
  created_by             uuid references users (id),
  updated_by             uuid references users (id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, pay_schedule_id) references pay_schedules (company_id, id),
  foreign key (company_id, workers_comp_class_id) references workers_comp_classes (company_id, id),
  foreign key (company_id, class_id) references classes (company_id, id),
  foreign key (company_id, location_id) references locations (company_id, id),
  check ((ssn_enc is null) = (ssn_last4 is null)),
  check (termination_date is null or termination_date >= hire_date),
  check (termination_reason is null or termination_date is not null)
);
create unique index employees_number_key on employees (company_id, lower(employee_number)) where employee_number is not null;
create index employees_name_idx on employees (company_id, lower(last_name), lower(first_name));
create trigger employees_touch before update on employees for each row execute function app_touch_updated_at();

-- Form W-4 as the employee filed it, from a date on. Payroll uses the one in effect on the pay
-- date; earlier forms stay for the record.
create table employee_w4 (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null,
  employee_id         uuid not null,
  effective_from      date not null check (effective_from between '1900-01-01' and '2199-12-31'),
  -- 2020 and later forms, or a form from 2019 or earlier kept by an employee who never refiled.
  form_version        text not null check (form_version in ('2020', 'pre2020')),
  filing_status       text not null,
  -- 2020+ Step 2(c), Step 3, Step 4(a), 4(b), 4(c).
  multiple_jobs       boolean not null default false,
  dependents_amount   numeric(19,4) not null default 0 check (dependents_amount >= 0),
  other_income        numeric(19,4) not null default 0 check (other_income >= 0),
  deductions          numeric(19,4) not null default 0 check (deductions >= 0),
  extra_withholding   numeric(19,4) not null default 0 check (extra_withholding >= 0),
  -- Pre-2020 line 5 (allowances) and line 6 (additional amount, kept in extra_withholding).
  allowances          smallint not null default 0 check (allowances between 0 and 99),
  exempt              boolean not null default false,
  nonresident_alien   boolean not null default false,
  created_by          uuid references users (id),
  created_at          timestamptz not null default now(),
  unique (employee_id, effective_from),
  foreign key (company_id, employee_id) references employees (company_id, id),
  check ((form_version = '2020' and filing_status in ('single', 'married_jointly', 'head_of_household'))
      or (form_version = 'pre2020' and filing_status in ('single', 'married', 'married_single_rate'))),
  check (form_version = '2020' or (not multiple_jobs and dependents_amount = 0 and other_income = 0 and deductions = 0)),
  check (form_version = 'pre2020' or allowances = 0)
);

-- State withholding certificates (IL-W-4, DE 4, IT-2104, ...). The fields differ by state; they
-- are validated by the state's schema in @acct/shared.
create table employee_state_certificates (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  employee_id     uuid not null,
  state           text not null check (state ~ '^[A-Z]{2}$'),
  effective_from  date not null check (effective_from between '1900-01-01' and '2199-12-31'),
  fields          jsonb not null,
  created_by      uuid references users (id),
  created_at      timestamptz not null default now(),
  unique (employee_id, state, effective_from),
  foreign key (company_id, employee_id) references employees (company_id, id)
);

-- Direct deposit accounts. The account number is encrypted (AAD
-- employee_bank_account:<id>:account_number); routing numbers are public.
create table employee_bank_accounts (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null,
  employee_id      uuid not null,
  position         smallint not null check (position between 1 and 3),
  routing_number   text not null check (routing_number ~ '^\d{9}$'),
  account_enc      text not null,
  account_last4    text not null check (account_last4 ~ '^\d{1,4}$'),
  account_type     text not null check (account_type in ('checking', 'savings')),
  -- fixed: a dollar amount; percent: of net pay; remainder: whatever is left (exactly one).
  amount_type      text not null check (amount_type in ('fixed', 'percent', 'remainder')),
  amount           numeric(19,4) check (amount > 0),
  prenote_status   text not null default 'none' check (prenote_status in ('none', 'pending', 'sent')),
  prenote_sent_on  date,
  created_by       uuid references users (id),
  updated_by       uuid references users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (employee_id, position),
  foreign key (company_id, employee_id) references employees (company_id, id),
  check ((amount_type = 'remainder') = (amount is null)),
  check (amount_type <> 'percent' or amount <= 100),
  check ((prenote_status = 'sent') = (prenote_sent_on is not null))
);
create unique index employee_bank_accounts_remainder_key on employee_bank_accounts (employee_id)
  where amount_type = 'remainder';
create trigger employee_bank_accounts_touch before update on employee_bank_accounts for each row execute function app_touch_updated_at();

-- Earnings and deductions on every regular paycheck (a 401(k) percentage, a garnishment order).
create table employee_pay_items (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null,
  employee_id      uuid not null,
  payroll_item_id  uuid not null,
  position         smallint not null check (position between 1 and 50),
  -- A dollar amount per paycheck, or a percent of gross pay.
  amount           numeric(19,4) check (amount >= 0),
  percent          numeric(7,4) check (percent >= 0 and percent <= 100),
  -- Stop at this much for the calendar year (e.g. a plan limit the employee chose).
  annual_limit     numeric(19,4) check (annual_limit >= 0),
  -- Garnishments: the order's case number and the total owed.
  case_number      text check (length(case_number) <= 50),
  total_owed       numeric(19,4) check (total_owed >= 0),
  unique (employee_id, position),
  foreign key (company_id, employee_id) references employees (company_id, id),
  foreign key (company_id, payroll_item_id) references payroll_items (company_id, id),
  check ((amount is null) <> (percent is null))
);

-- The PTO policies an employee is on, with the balance they started with here.
create table employee_pto (
  company_id        uuid not null,
  employee_id       uuid not null,
  policy_id         uuid not null,
  opening_balance   numeric(9,2) not null default 0 check (opening_balance between -9999 and 99999),
  opening_as_of     date not null check (opening_as_of between '1900-01-01' and '2199-12-31'),
  primary key (employee_id, policy_id),
  foreign key (company_id, employee_id) references employees (company_id, id),
  foreign key (company_id, policy_id) references pto_policies (company_id, id)
);

-- ---------------------------------------------------------------------------------------------
-- Direct deposit files: what was generated, never the file itself (it holds account numbers).
-- ---------------------------------------------------------------------------------------------
create table ach_batches (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies (id) on delete cascade,
  kind            text not null check (kind in ('prenote', 'payroll')),
  effective_date  date not null,
  entry_count     integer not null check (entry_count > 0),
  total_credit    numeric(19,4) not null check (total_credit >= 0),
  file_sha256     text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  created_by      uuid references users (id),
  created_at      timestamptz not null default now(),
  unique (company_id, id)
);
create index ach_batches_company_idx on ach_batches (company_id, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- Contractors: Form W-9 on the vendor record (the TIN is already encrypted there).
-- ---------------------------------------------------------------------------------------------
alter table vendors
  add column w9_received_on      date check (w9_received_on between '1900-01-01' and '2199-12-31'),
  add column backup_withholding  boolean not null default false;

do $$
declare t text;
begin
  foreach t in array array['payroll_settings', 'pay_schedules', 'payroll_state_registrations',
                           'state_unemployment_rates', 'workers_comp_classes', 'pto_policies',
                           'payroll_items', 'employees', 'employee_w4',
                           'employee_state_certificates', 'employee_bank_accounts',
                           'employee_pay_items', 'employee_pto', 'ach_batches']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for all using (company_id = app_current_company_id()) with check (company_id = app_current_company_id())',
      t || '_tenant', t);
  end loop;
end $$;

-- Setup records and employees are deactivated or terminated, never deleted. Withholding
-- certificates are history: a new one is added, a mistaken one removed. Direct deposit accounts,
-- recurring items and PTO assignments are replaced on save. ACH batches are a log.
grant select, insert, update on payroll_settings, pay_schedules, payroll_state_registrations,
  workers_comp_classes, pto_policies, payroll_items, employees to acct_app;
grant select, insert, delete on employee_w4, employee_state_certificates to acct_app;
grant select, insert, update, delete on state_unemployment_rates, employee_bank_accounts,
  employee_pay_items, employee_pto to acct_app;
grant select, insert on ach_batches to acct_app;
