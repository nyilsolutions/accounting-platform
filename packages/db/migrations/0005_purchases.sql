-- Phase 3: purchases and accounts payable.
--
-- Bills, vendor credits, bill payments, checks, expenses and credit card credits are
-- `transactions` posting through the versioned journal (ADR 0007), with current-state detail in
-- purchase_lines. Bill payments apply to bills and vendor credits through payment_applications
-- (the same table customer payments use). Purchase orders do not post and have their own tables.

-- ---------------------------------------------------------------------------------------------
-- Transaction header: purchase document types and fields
-- ---------------------------------------------------------------------------------------------
alter table transactions drop constraint transactions_txn_type_check;
alter table transactions add constraint transactions_txn_type_check check (txn_type in (
  'journal_entry', 'invoice', 'sales_receipt', 'credit_memo', 'refund_receipt', 'payment', 'deposit',
  'bill', 'vendor_credit', 'bill_payment', 'check', 'expense', 'cc_credit'));

alter table transactions
  add column vendor_id           uuid,
  -- Bank or credit card account that paid (checks, expenses, credit card credits, bill payments).
  add column payment_account_id  uuid,
  -- Checks and bill payments by check: 'to_print' until printed, then 'printed'.
  add column print_status        text check (print_status in ('to_print', 'printed')),
  add column mailing_address     text check (length(mailing_address) <= 1000),
  add foreign key (company_id, vendor_id) references vendors (company_id, id),
  add foreign key (company_id, payment_account_id) references accounts (company_id, id);

create index transactions_vendor_idx on transactions (company_id, vendor_id, txn_date);
create index transactions_to_print_idx on transactions (company_id, payment_account_id)
  where print_status = 'to_print';

-- Credit-only payments (customer or vendor) move no money and have no journal lines.
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
    if line_count = 0 and hdr.txn_type in ('payment', 'bill_payment') and hdr.total = 0 then
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

-- ---------------------------------------------------------------------------------------------
-- Purchase lines (bill, vendor credit, check, expense, credit card credit): a category (account)
-- or a product/service, optionally tagged with the customer/job it was for and a class.
-- ---------------------------------------------------------------------------------------------
create table purchase_lines (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  transaction_id  uuid not null,
  line_no         integer not null check (line_no between 1 and 1000),
  item_id         uuid,
  -- Account the line posts to (the item's expense account, or chosen directly).
  account_id      uuid not null,
  description     text check (length(description) <= 4000),
  quantity        numeric(19,4),
  rate            numeric(19,4),
  amount          numeric(19,4) not null,
  customer_id     uuid,
  class_id        uuid,
  foreign key (company_id, transaction_id) references transactions (company_id, id),
  foreign key (company_id, item_id) references items (company_id, id),
  foreign key (company_id, account_id) references accounts (company_id, id),
  foreign key (company_id, customer_id) references customers (company_id, id),
  foreign key (company_id, class_id) references classes (company_id, id),
  unique (transaction_id, line_no)
);
create index purchase_lines_item_idx on purchase_lines (company_id, item_id);

-- ---------------------------------------------------------------------------------------------
-- Purchase orders: no ledger impact; copied to a bill when the goods or bill arrive.
-- ---------------------------------------------------------------------------------------------
create table purchase_orders (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies (id) on delete cascade,
  number          text check (length(number) <= 30),
  vendor_id       uuid not null,
  txn_date        date not null,
  expected_date   date,
  status          text not null default 'open' check (status in ('open', 'closed')),
  vendor_address  text check (length(vendor_address) <= 1000),
  ship_to         text check (length(ship_to) <= 1000),
  email_to        text check (length(email_to) <= 1000),
  vendor_message  text check (length(vendor_message) <= 4000),
  memo            text check (length(memo) <= 4000),
  total           numeric(19,4) not null default 0,
  bill_id         uuid,
  sent_at         timestamptz,
  created_by      uuid references users (id),
  updated_by      uuid references users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, vendor_id) references vendors (company_id, id),
  foreign key (company_id, bill_id) references transactions (company_id, id)
);
create unique index purchase_orders_number_key on purchase_orders (company_id, lower(number)) where number is not null;
create trigger purchase_orders_touch before update on purchase_orders for each row execute function app_touch_updated_at();

create table purchase_order_lines (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null,
  purchase_order_id  uuid not null,
  line_no            integer not null check (line_no between 1 and 1000),
  item_id            uuid,
  account_id         uuid,
  description        text check (length(description) <= 4000),
  quantity           numeric(19,4),
  rate               numeric(19,4),
  amount             numeric(19,4) not null,
  customer_id        uuid,
  class_id           uuid,
  foreign key (company_id, purchase_order_id) references purchase_orders (company_id, id) on delete cascade,
  foreign key (company_id, item_id) references items (company_id, id),
  foreign key (company_id, account_id) references accounts (company_id, id),
  foreign key (company_id, customer_id) references customers (company_id, id),
  foreign key (company_id, class_id) references classes (company_id, id),
  check (item_id is not null or account_id is not null),
  unique (purchase_order_id, line_no)
);

-- ---------------------------------------------------------------------------------------------
-- 1099 mapping: which expense accounts feed which 1099 box (like the QuickBooks 1099 wizard).
-- ---------------------------------------------------------------------------------------------
create table vendor_1099_accounts (
  company_id  uuid not null references companies (id) on delete cascade,
  account_id  uuid not null,
  box         text not null check (box in ('nec_1', 'misc_1', 'misc_2', 'misc_3', 'misc_6')),
  primary key (company_id, account_id),
  foreign key (company_id, account_id) references accounts (company_id, id)
);

-- ---------------------------------------------------------------------------------------------
-- Row-Level Security and grants
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['purchase_lines', 'purchase_orders', 'purchase_order_lines', 'vendor_1099_accounts']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for all using (company_id = app_current_company_id()) with check (company_id = app_current_company_id())',
      t || '_tenant', t);
  end loop;
end $$;

grant select, insert, delete on purchase_lines, vendor_1099_accounts to acct_app;
grant select, insert, update, delete on purchase_orders, purchase_order_lines to acct_app;
