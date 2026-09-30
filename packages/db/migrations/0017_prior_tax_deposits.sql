-- Phase 9: federal tax deposits for periods before payroll started here (open question 59).
--
-- A company that starts mid-quarter made that quarter's earlier deposits through its old payroll
-- service. Form 941's and Form 940's deposit figures need them. They count on the forms only:
-- they are not posted to the books (the old system recorded them) and don't touch the
-- liabilities (prior payroll adds none). Like prior payroll, they can change until a filed form
-- covers their period.

create table prior_tax_deposits (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies (id) on delete cascade,
  -- federal_941 (Form 941 taxes) or federal_940 (FUTA)
  agency        text not null check (agency in ('federal_941', 'federal_940')),
  tax_year      smallint not null check (tax_year between 2000 and 2199),
  quarter       smallint not null check (quarter between 1 and 4),
  payment_date  date not null check (payment_date between '2000-01-01' and '2199-12-31'),
  amount        numeric(19,4) not null check (amount > 0),
  memo          text check (length(memo) <= 200),
  created_by    uuid references users (id),
  updated_by    uuid references users (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (company_id, id)
);
create index prior_tax_deposits_period_idx on prior_tax_deposits (company_id, agency, tax_year, quarter);
create trigger prior_tax_deposits_touch before update on prior_tax_deposits
  for each row execute function app_touch_updated_at();

alter table prior_tax_deposits enable row level security;
create policy prior_tax_deposits_tenant on prior_tax_deposits for all
  using (company_id = app_current_company_id()) with check (company_id = app_current_company_id());

grant select, insert, update, delete on prior_tax_deposits to acct_app;
