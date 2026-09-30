-- Phase 8 (part 2): paying payroll liabilities.
--
-- What the company owes each agency comes from posted paychecks' lines (taxes, deductions,
-- company contributions). A payment is a 'payroll_liability_payment' transaction (liability
-- debited, bank credited) posted through PostingService, recorded here against the agency and the
-- deposit period it pays so balances by period can be shown. Payments are voided, never deleted.

alter table transactions drop constraint transactions_txn_type_check;
alter table transactions add constraint transactions_txn_type_check check (txn_type in (
  'journal_entry', 'invoice', 'sales_receipt', 'credit_memo', 'refund_receipt', 'payment', 'deposit',
  'bill', 'vendor_credit', 'bill_payment', 'check', 'expense', 'cc_credit', 'transfer',
  'sales_tax_payment', 'sales_tax_adjustment', 'paycheck', 'payroll_liability_payment'));

create table payroll_liability_payments (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies (id) on delete cascade,
  -- federal_941, federal_940, state_withholding:XX, state_unemployment:XX, ny_pfl, item:<uuid>
  agency          text not null check (agency ~ '^(federal_941|federal_940|ny_pfl|state_(withholding|unemployment):[A-Z]{2}|item:[0-9a-f-]{36})$'),
  period_start    date not null,
  period_end      date not null,
  payment_date    date not null check (payment_date between '1900-01-01' and '2199-12-31'),
  amount          numeric(19,4) not null check (amount > 0),
  method          text not null check (method in ('eftps', 'ach', 'check', 'other')),
  reference       text check (length(reference) <= 40),
  status          text not null default 'posted' check (status in ('posted', 'void')),
  transaction_id  uuid not null,
  created_by      uuid references users (id),
  created_at      timestamptz not null default now(),
  voided_by       uuid references users (id),
  voided_at       timestamptz,
  unique (company_id, id),
  foreign key (company_id, transaction_id) references transactions (company_id, id),
  check (period_start <= period_end),
  check ((status = 'void') = (voided_at is not null))
);
create index payroll_liability_payments_agency_idx
  on payroll_liability_payments (company_id, agency, period_start);

alter table payroll_liability_payments enable row level security;
create policy payroll_liability_payments_tenant on payroll_liability_payments for all
  using (company_id = app_current_company_id()) with check (company_id = app_current_company_id());

-- Recorded and voided, never deleted or changed otherwise (the service only sets status).
grant select, insert, update on payroll_liability_payments to acct_app;
