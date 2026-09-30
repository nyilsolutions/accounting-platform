-- Phase 10b: time tracking and progress invoicing (ADR 0019).
--
--   * time_entries: hours an employee or a vendor (contractor) worked on a date, optionally for a
--     customer (job) and service item, billable or not. Entries are submitted, then approved (or
--     rejected) by a payroll admin or the employee's manager. Only approved time feeds paychecks
--     and invoices; an entry paid on a paycheck or billed on an invoice stays approved.
--   * employees.manager_user_id: the member who may approve that employee's time.
--   * Progress invoicing: an invoice line may come from an estimate line (estimate_id,
--     estimate_line_no). What has been invoiced of each estimate line is the sum of those lines on
--     posted invoices.

alter table employees add column manager_user_id uuid references users (id);

create table time_entries (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies (id) on delete cascade,
  -- Who worked: an employee or a vendor (contractor), never both.
  employee_id      uuid,
  vendor_id        uuid,
  work_date        date not null check (work_date between '1900-01-01' and '2199-12-31'),
  hours            numeric(9,4) not null check (hours > 0 and hours <= 24),
  -- For whom (the job) and what (a service item).
  customer_id      uuid,
  item_id          uuid,
  -- Employees: the earning the hours are paid as (overtime, double time...); null: regular hourly.
  payroll_item_id  uuid,
  billable         boolean not null default false,
  -- Billable time: the rate to bill; null uses the service item's sales price.
  billing_rate     numeric(19,4) check (billing_rate >= 0),
  class_id         uuid,
  notes            text check (length(notes) <= 4000),
  status           text not null default 'open'
                     check (status in ('open', 'submitted', 'approved', 'rejected')),
  submitted_at     timestamptz,
  submitted_by     uuid references users (id),
  approved_at      timestamptz,
  approved_by      uuid references users (id),
  rejection_note   text check (length(rejection_note) <= 1000),
  -- Where approved time was used.
  paycheck_id      uuid,
  invoice_id       uuid,
  invoice_line_no  smallint check (invoice_line_no between 1 and 1000),
  created_by       uuid references users (id),
  updated_by       uuid references users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, employee_id) references employees (company_id, id),
  foreign key (company_id, vendor_id) references vendors (company_id, id),
  foreign key (company_id, customer_id) references customers (company_id, id),
  foreign key (company_id, item_id) references items (company_id, id),
  foreign key (company_id, payroll_item_id) references payroll_items (company_id, id),
  foreign key (company_id, class_id) references classes (company_id, id),
  -- A draft paycheck that is deleted frees its time.
  foreign key (company_id, paycheck_id) references paychecks (company_id, id)
    on delete set null (paycheck_id),
  foreign key (company_id, invoice_id) references transactions (company_id, id),
  check ((employee_id is null) <> (vendor_id is null)),
  check (billable = false or customer_id is not null),
  check (payroll_item_id is null or employee_id is not null),
  check (paycheck_id is null or employee_id is not null),
  check ((status = 'approved') = (approved_at is not null)),
  check ((status in ('submitted', 'approved')) = (submitted_at is not null)),
  check (status = 'approved' or (paycheck_id is null and invoice_id is null)),
  check ((invoice_id is null) = (invoice_line_no is null)),
  check (invoice_id is null or billable)
);
create index time_entries_employee_idx on time_entries (company_id, employee_id, work_date);
create index time_entries_vendor_idx on time_entries (company_id, vendor_id, work_date);
create index time_entries_unbilled_idx on time_entries (company_id, customer_id)
  where billable and invoice_id is null;
create index time_entries_paycheck_idx on time_entries (paycheck_id) where paycheck_id is not null;
create index time_entries_invoice_idx on time_entries (invoice_id) where invoice_id is not null;
create trigger time_entries_touch before update on time_entries
  for each row execute function app_touch_updated_at();

alter table time_entries enable row level security;
create policy time_entries_tenant on time_entries for all
  using (company_id = app_current_company_id()) with check (company_id = app_current_company_id());
grant select, insert, update, delete on time_entries to acct_app;

-- Progress invoicing: invoice lines that bill part of an estimate line.
alter table sales_lines
  add column estimate_id uuid,
  add column estimate_line_no integer check (estimate_line_no between 1 and 1000),
  add foreign key (company_id, estimate_id) references estimates (company_id, id),
  add constraint sales_lines_estimate_line check ((estimate_id is null) = (estimate_line_no is null));
create index sales_lines_estimate_idx on sales_lines (estimate_id) where estimate_id is not null;
