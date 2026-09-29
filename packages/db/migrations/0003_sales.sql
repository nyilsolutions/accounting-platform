-- Phase 2: sales and accounts receivable.
--
-- Invoices, sales receipts, credit memos, refund receipts, customer payments and bank deposits
-- are all `transactions` that post through the same versioned journal (ADR 0007). Their
-- document detail lives in the tables below, which hold the CURRENT state of each document
-- (replaced on edit, history in the audit log). Only journal_lines are append-only.
-- Estimates do not post to the ledger and have their own tables.

-- ---------------------------------------------------------------------------------------------
-- Transaction header: new document types and sales fields
-- ---------------------------------------------------------------------------------------------
alter table transactions drop constraint transactions_txn_type_check;
alter table transactions add constraint transactions_txn_type_check check (txn_type in (
  'journal_entry', 'invoice', 'sales_receipt', 'credit_memo', 'refund_receipt', 'payment', 'deposit'));

alter table transactions
  add column customer_id        uuid,
  add column due_date           date,
  add column terms_id           uuid,
  add column payment_method_id  uuid,
  add column reference          text check (length(reference) <= 50),
  -- Bank / Undeposited Funds account for receipts, payments, refunds and deposits.
  add column deposit_account_id uuid,
  add column customer_message   text check (length(customer_message) <= 4000),
  add column bill_to            text check (length(bill_to) <= 1000),
  add column email_to           text check (length(email_to) <= 1000),
  add column sent_at            timestamptz,
  -- Document amount: invoice/receipt/credit/refund total, payment amount received, deposit total.
  add column total              numeric(19,4) check (total >= 0),
  add foreign key (company_id, customer_id) references customers (company_id, id),
  add foreign key (company_id, terms_id) references terms (company_id, id),
  add foreign key (company_id, payment_method_id) references payment_methods (company_id, id),
  add foreign key (company_id, deposit_account_id) references accounts (company_id, id);

create index transactions_customer_idx on transactions (company_id, customer_id, txn_date);
-- Document numbers are unique per type (journal entry numbers stay free-form).
create unique index transactions_doc_number_key on transactions (company_id, txn_type, lower(txn_number))
  where txn_number is not null and status <> 'deleted'
    and txn_type in ('invoice', 'sales_receipt', 'credit_memo', 'refund_receipt');

-- A payment that only applies a credit memo to an invoice moves no money and has no journal
-- lines. Every other transaction still needs balanced lines.
create or replace function app_check_transaction_balanced() returns trigger
  language plpgsql
  as $$
  declare
    txn_id uuid;
    cur_version int;
    total_debit numeric;
    total_credit numeric;
    line_count int;
    hdr record;
  begin
    if tg_table_name = 'journal_lines' then txn_id := new.transaction_id; else txn_id := new.id; end if;
    select version, txn_type, total into hdr from transactions where id = txn_id;
    cur_version := hdr.version;
    select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
      into total_debit, total_credit, line_count
      from journal_lines where transaction_id = txn_id and version = cur_version;
    if line_count = 0 and hdr.txn_type = 'payment' and hdr.total = 0 then
      return null;
    end if;
    if line_count < 2 then
      raise exception 'Transaction % must have at least two lines', txn_id using errcode = 'check_violation';
    end if;
    if total_debit <> total_credit then
      raise exception 'Transaction % is not balanced: debits % <> credits %', txn_id, total_debit, total_credit
        using errcode = 'check_violation';
    end if;
    return null;
  end $$;

-- The closing-date lock applies to accounting changes (date, amounts via a new version, status),
-- not to bookkeeping metadata such as "sent by email".
create or replace function app_enforce_closing_date() returns trigger
  language plpgsql
  as $$
  declare
    closed date;
    touched date;
  begin
    if coalesce(current_setting('app.closing_override', true), '') = 'on' then return new; end if;
    -- Nested IFs: PL/pgSQL does not short-circuit AND, and journal_lines rows have no status.
    if tg_table_name = 'transactions' and tg_op = 'UPDATE' then
      if new.txn_date = old.txn_date and new.version = old.version and new.status = old.status then
        return new;
      end if;
    end if;
    select closing_date into closed from companies where id = new.company_id;
    if closed is null then return new; end if;
    if tg_table_name = 'journal_lines' then
      touched := new.txn_date;
    elsif tg_op = 'UPDATE' then
      touched := least(old.txn_date, new.txn_date);
    else
      touched := new.txn_date;
    end if;
    if touched <= closed then
      raise exception 'The books are closed through %. Enter the closing date password to change this period.', closed
        using errcode = 'P0001', hint = 'closing_date';
    end if;
    return new;
  end $$;

-- ---------------------------------------------------------------------------------------------
-- Sales document lines (invoice, sales receipt, credit memo, refund receipt)
-- ---------------------------------------------------------------------------------------------
create table sales_lines (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  transaction_id  uuid not null,
  line_no         integer not null check (line_no between 1 and 1000),
  item_id         uuid,
  description     text check (length(description) <= 4000),
  quantity        numeric(19,4),
  rate            numeric(19,4),
  amount          numeric(19,4) not null,
  -- Income account the line posts to (from the item, or chosen directly).
  account_id      uuid not null,
  class_id        uuid,
  service_date    date,
  taxable         boolean not null default false,
  foreign key (company_id, transaction_id) references transactions (company_id, id),
  foreign key (company_id, item_id) references items (company_id, id),
  foreign key (company_id, account_id) references accounts (company_id, id),
  foreign key (company_id, class_id) references classes (company_id, id),
  unique (transaction_id, line_no)
);
create index sales_lines_item_idx on sales_lines (company_id, item_id);

-- ---------------------------------------------------------------------------------------------
-- Payment applications: a payment pays invoices and may use open credit memos.
--   open(invoice)     = invoice.total     - sum(applications to it)
--   open(credit memo) = credit_memo.total - sum(applications to it)
--   unapplied(payment) = payment.total + credits used - invoices paid   (>= 0, a customer credit)
-- ---------------------------------------------------------------------------------------------
create table payment_applications (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null,
  payment_id  uuid not null,
  target_id   uuid not null,
  amount      numeric(19,4) not null check (amount > 0),
  foreign key (company_id, payment_id) references transactions (company_id, id),
  foreign key (company_id, target_id) references transactions (company_id, id),
  unique (payment_id, target_id),
  check (payment_id <> target_id)
);
create index payment_applications_target_idx on payment_applications (target_id);

-- ---------------------------------------------------------------------------------------------
-- Deposit lines: funds moved from Undeposited Funds (source_txn_id set) or other deposits.
-- A payment or sales receipt can be in at most one deposit.
-- ---------------------------------------------------------------------------------------------
create table deposit_lines (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null,
  deposit_id         uuid not null,
  line_no            integer not null check (line_no between 1 and 1000),
  source_txn_id      uuid,
  account_id         uuid not null,
  amount             numeric(19,4) not null check (amount > 0),
  customer_id        uuid,
  description        text check (length(description) <= 4000),
  payment_method_id  uuid,
  reference          text check (length(reference) <= 50),
  class_id           uuid,
  foreign key (company_id, deposit_id) references transactions (company_id, id),
  foreign key (company_id, source_txn_id) references transactions (company_id, id),
  foreign key (company_id, account_id) references accounts (company_id, id),
  foreign key (company_id, customer_id) references customers (company_id, id),
  foreign key (company_id, payment_method_id) references payment_methods (company_id, id),
  foreign key (company_id, class_id) references classes (company_id, id),
  unique (deposit_id, line_no)
);
create unique index deposit_lines_source_key on deposit_lines (source_txn_id) where source_txn_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Estimates (quotes): no ledger impact until converted to an invoice.
-- ---------------------------------------------------------------------------------------------
create table estimates (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies (id) on delete cascade,
  number            text check (length(number) <= 30),
  customer_id       uuid not null,
  txn_date          date not null,
  expiration_date   date,
  status            text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'closed')),
  bill_to           text check (length(bill_to) <= 1000),
  email_to          text check (length(email_to) <= 1000),
  customer_message  text check (length(customer_message) <= 4000),
  memo              text check (length(memo) <= 4000),
  total             numeric(19,4) not null default 0,
  invoice_id        uuid,
  sent_at           timestamptz,
  created_by        uuid references users (id),
  updated_by        uuid references users (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, customer_id) references customers (company_id, id),
  foreign key (company_id, invoice_id) references transactions (company_id, id)
);
create unique index estimates_number_key on estimates (company_id, lower(number)) where number is not null;
create trigger estimates_touch before update on estimates for each row execute function app_touch_updated_at();

create table estimate_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  estimate_id   uuid not null,
  line_no       integer not null check (line_no between 1 and 1000),
  item_id       uuid,
  description   text check (length(description) <= 4000),
  quantity      numeric(19,4),
  rate          numeric(19,4),
  amount        numeric(19,4) not null,
  class_id      uuid,
  service_date  date,
  taxable       boolean not null default false,
  foreign key (company_id, estimate_id) references estimates (company_id, id) on delete cascade,
  foreign key (company_id, item_id) references items (company_id, id),
  foreign key (company_id, class_id) references classes (company_id, id),
  unique (estimate_id, line_no)
);

-- ---------------------------------------------------------------------------------------------
-- Row-Level Security and grants
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['sales_lines', 'payment_applications', 'deposit_lines', 'estimates', 'estimate_lines']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for all using (company_id = app_current_company_id()) with check (company_id = app_current_company_id())',
      t || '_tenant', t);
  end loop;
end $$;

grant select, insert, delete on sales_lines, payment_applications, deposit_lines to acct_app;
grant select, insert, update, delete on estimates, estimate_lines to acct_app;
