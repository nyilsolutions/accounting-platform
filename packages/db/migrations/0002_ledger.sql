-- Phase 1: ledger core. Chart of accounts, name lists, tracking dimensions, and the
-- double-entry journal.
--
-- Ledger integrity model (see docs/adr/0007-ledger-posting-model.md):
--   * `transactions` is the header for every business document (Phase 1: journal entries).
--   * `journal_lines` rows are APPEND-ONLY. Editing a transaction bumps `transactions.version`
--     and inserts a complete new set of lines with that version. Reports read only the lines
--     whose version equals the header's current version, and only for posted transactions.
--     The app role has no UPDATE/DELETE on journal_lines, so ledger history can never be
--     rewritten.
--   * A deferred constraint trigger rejects any commit that leaves a transaction's current
--     lines unbalanced (sum of debits <> sum of credits).
--   * A trigger rejects postings dated on or before the company's closing date unless the API
--     has verified the closing password and set `app.closing_override` for the transaction.
--   * Composite foreign keys (company_id, id) make cross-company references impossible.

-- ---------------------------------------------------------------------------------------------
-- Company ledger settings
-- ---------------------------------------------------------------------------------------------
alter table companies
  add column use_account_numbers   boolean not null default false,
  add column closing_date          date,
  add column closing_password_hash text;

-- ---------------------------------------------------------------------------------------------
-- Chart of accounts
-- ---------------------------------------------------------------------------------------------
create table accounts (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies (id) on delete cascade,
  number       text check (number ~ '^[A-Za-z0-9.\-]{1,20}$'),
  name         text not null check (length(name) between 1 and 100 and name !~ ':'),
  account_type text not null check (account_type in (
                 'bank','accounts_receivable','other_current_asset','fixed_asset','other_asset',
                 'accounts_payable','credit_card','other_current_liability','long_term_liability',
                 'equity','income','cost_of_goods_sold','expense','other_income','other_expense')),
  detail_type  text,
  parent_id    uuid,
  description  text,
  system_role  text check (system_role in (
                 'accounts_receivable','accounts_payable','undeposited_funds','opening_balance_equity',
                 'retained_earnings','sales_tax_payable','uncategorized_income','uncategorized_expense',
                 'uncategorized_asset','payroll_liabilities','payroll_expenses','cost_of_goods_sold')),
  is_active    boolean not null default true,
  created_by   uuid references users (id),
  updated_by   uuid references users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, parent_id) references accounts (company_id, id),
  check (parent_id is null or parent_id <> id)
);
create unique index accounts_name_key on accounts
  (company_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create unique index accounts_number_key on accounts (company_id, lower(number)) where number is not null;
create unique index accounts_system_role_key on accounts (company_id, system_role) where system_role is not null;
create index accounts_parent_idx on accounts (company_id, parent_id);
create trigger accounts_touch before update on accounts for each row execute function app_touch_updated_at();

-- Sub-accounts must share the parent's type; the hierarchy must not contain cycles.
create function app_accounts_check_parent() returns trigger
  language plpgsql
  as $$
  declare
    parent_type text;
    cursor_id uuid := new.parent_id;
    depth int := 0;
  begin
    if new.parent_id is null then return new; end if;
    select account_type into parent_type from accounts where id = new.parent_id and company_id = new.company_id;
    if parent_type is distinct from new.account_type then
      raise exception 'A sub-account must have the same type as its parent account'
        using errcode = 'check_violation';
    end if;
    while cursor_id is not null loop
      if cursor_id = new.id then
        raise exception 'An account cannot be its own ancestor' using errcode = 'check_violation';
      end if;
      depth := depth + 1;
      if depth > 5 then
        raise exception 'Accounts can be nested at most 5 levels deep' using errcode = 'check_violation';
      end if;
      select parent_id into cursor_id from accounts where id = cursor_id;
    end loop;
    return new;
  end $$;
create trigger accounts_check_parent before insert or update of parent_id, account_type on accounts
  for each row execute function app_accounts_check_parent();

-- ---------------------------------------------------------------------------------------------
-- Terms, payment methods, classes, locations
-- ---------------------------------------------------------------------------------------------
create table terms (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies (id) on delete cascade,
  name              text not null check (length(name) between 1 and 100),
  due_days          integer not null default 0 check (due_days between 0 and 999),
  discount_percent  numeric(7,4) not null default 0 check (discount_percent between 0 and 100),
  discount_days     integer not null default 0 check (discount_days between 0 and 999),
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (company_id, id)
);
create unique index terms_name_key on terms (company_id, lower(name));
create trigger terms_touch before update on terms for each row execute function app_touch_updated_at();

create table payment_methods (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies (id) on delete cascade,
  name        text not null check (length(name) between 1 and 100),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, id)
);
create unique index payment_methods_name_key on payment_methods (company_id, lower(name));
create trigger payment_methods_touch before update on payment_methods for each row execute function app_touch_updated_at();

create table classes (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies (id) on delete cascade,
  name        text not null check (length(name) between 1 and 100 and name !~ ':'),
  parent_id   uuid,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, parent_id) references classes (company_id, id),
  check (parent_id is null or parent_id <> id)
);
create unique index classes_name_key on classes
  (company_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create trigger classes_touch before update on classes for each row execute function app_touch_updated_at();

create table locations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies (id) on delete cascade,
  name        text not null check (length(name) between 1 and 100 and name !~ ':'),
  parent_id   uuid,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, parent_id) references locations (company_id, id),
  check (parent_id is null or parent_id <> id)
);
create unique index locations_name_key on locations
  (company_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create trigger locations_touch before update on locations for each row execute function app_touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Customers and vendors
-- ---------------------------------------------------------------------------------------------
create table customers (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies (id) on delete cascade,
  display_name    text not null check (length(display_name) between 1 and 200 and display_name !~ ':'),
  parent_id       uuid,
  company_name    text,
  first_name      text,
  last_name       text,
  email           text,
  phone           text,
  address_line1   text,
  address_line2   text,
  city            text,
  state           text,
  postal_code     text,
  country         text not null default 'US',
  terms_id        uuid,
  tax_exempt      boolean not null default false,
  notes           text,
  is_active       boolean not null default true,
  created_by      uuid references users (id),
  updated_by      uuid references users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, parent_id) references customers (company_id, id),
  foreign key (company_id, terms_id) references terms (company_id, id),
  check (parent_id is null or parent_id <> id)
);
create unique index customers_name_key on customers
  (company_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(display_name));
create trigger customers_touch before update on customers for each row execute function app_touch_updated_at();

create table vendors (
  id                          uuid primary key default gen_random_uuid(),
  company_id                  uuid not null references companies (id) on delete cascade,
  display_name                text not null check (length(display_name) between 1 and 200 and display_name !~ ':'),
  company_name                text,
  first_name                  text,
  last_name                   text,
  email                       text,
  phone                       text,
  address_line1               text,
  address_line2               text,
  city                        text,
  state                       text,
  postal_code                 text,
  country                     text not null default 'US',
  terms_id                    uuid,
  account_number              text,
  is_1099                     boolean not null default false,
  tin_type                    text check (tin_type in ('ein','ssn')),
  tin_enc                     text,
  tin_last4                   text check (tin_last4 ~ '^\d{4}$'),
  default_expense_account_id  uuid,
  notes                       text,
  is_active                   boolean not null default true,
  created_by                  uuid references users (id),
  updated_by                  uuid references users (id),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, terms_id) references terms (company_id, id),
  foreign key (company_id, default_expense_account_id) references accounts (company_id, id),
  check ((tin_enc is null) = (tin_last4 is null))
);
create unique index vendors_name_key on vendors (company_id, lower(display_name));
create trigger vendors_touch before update on vendors for each row execute function app_touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Products and services (inventory item types arrive with inventory in Phase 10)
-- ---------------------------------------------------------------------------------------------
create table items (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references companies (id) on delete cascade,
  name                  text not null check (length(name) between 1 and 100 and name !~ ':'),
  sku                   text,
  item_type             text not null check (item_type in ('service','non_inventory','other_charge')),
  description           text,
  sales_price           numeric(19,4) check (sales_price >= 0),
  income_account_id     uuid,
  purchase_description  text,
  cost                  numeric(19,4) check (cost >= 0),
  expense_account_id    uuid,
  taxable               boolean not null default false,
  is_active             boolean not null default true,
  created_by            uuid references users (id),
  updated_by            uuid references users (id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, income_account_id) references accounts (company_id, id),
  foreign key (company_id, expense_account_id) references accounts (company_id, id),
  check (income_account_id is not null or expense_account_id is not null)
);
create unique index items_name_key on items (company_id, lower(name));
create unique index items_sku_key on items (company_id, lower(sku)) where sku is not null;
create trigger items_touch before update on items for each row execute function app_touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Transactions and the journal
-- ---------------------------------------------------------------------------------------------
create table transactions (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies (id) on delete restrict,
  txn_type        text not null check (txn_type in ('journal_entry')),
  txn_number      text check (length(txn_number) <= 30),
  txn_date        date not null check (txn_date between '1900-01-01' and '2199-12-31'),
  memo            text check (length(memo) <= 4000),
  status          text not null default 'posted' check (status in ('posted','void','deleted')),
  version         integer not null default 1 check (version >= 1),
  is_adjusting    boolean not null default false,
  reversal_of_id  uuid,
  source          text not null default 'manual' check (source in ('manual','import','bank_feed','api','system')),
  created_by      uuid references users (id),
  updated_by      uuid references users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  voided_at       timestamptz,
  voided_by       uuid references users (id),
  deleted_at      timestamptz,
  deleted_by      uuid references users (id),
  unique (company_id, id),
  foreign key (company_id, reversal_of_id) references transactions (company_id, id)
);
create index transactions_company_date_idx on transactions (company_id, txn_date, id);
create index transactions_company_type_idx on transactions (company_id, txn_type, txn_date desc);
create trigger transactions_touch before update on transactions for each row execute function app_touch_updated_at();

create table journal_lines (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  transaction_id  uuid not null,
  version         integer not null,
  line_no         integer not null check (line_no between 1 and 1000),
  txn_date        date not null,
  account_id      uuid not null,
  debit           numeric(19,4) not null default 0 check (debit >= 0),
  credit          numeric(19,4) not null default 0 check (credit >= 0),
  description     text check (length(description) <= 4000),
  customer_id     uuid,
  vendor_id       uuid,
  class_id        uuid,
  location_id     uuid,
  created_at      timestamptz not null default now(),
  foreign key (company_id, transaction_id) references transactions (company_id, id),
  foreign key (company_id, account_id) references accounts (company_id, id),
  foreign key (company_id, customer_id) references customers (company_id, id),
  foreign key (company_id, vendor_id) references vendors (company_id, id),
  foreign key (company_id, class_id) references classes (company_id, id),
  foreign key (company_id, location_id) references locations (company_id, id),
  unique (transaction_id, version, line_no),
  check (debit = 0 or credit = 0),
  check (debit > 0 or credit > 0),
  check (customer_id is null or vendor_id is null)
);
create index journal_lines_txn_idx on journal_lines (transaction_id, version);
create index journal_lines_account_idx on journal_lines (company_id, account_id, txn_date);

create function app_journal_lines_immutable() returns trigger
  language plpgsql
  as $$ begin raise exception 'journal_lines are append-only; post a new version instead'; end $$;
create trigger journal_lines_no_update before update or delete on journal_lines
  for each row execute function app_journal_lines_immutable();

-- Balanced-entry check at commit time, for any transaction whose lines or version changed.
create function app_check_transaction_balanced() returns trigger
  language plpgsql
  as $$
  declare
    txn_id uuid;
    cur_version int;
    total_debit numeric;
    total_credit numeric;
    line_count int;
  begin
    if tg_table_name = 'journal_lines' then txn_id := new.transaction_id; else txn_id := new.id; end if;
    select version into cur_version from transactions where id = txn_id;
    select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
      into total_debit, total_credit, line_count
      from journal_lines where transaction_id = txn_id and version = cur_version;
    if line_count < 2 then
      raise exception 'Transaction % must have at least two lines', txn_id using errcode = 'check_violation';
    end if;
    if total_debit <> total_credit then
      raise exception 'Transaction % is not balanced: debits % <> credits %', txn_id, total_debit, total_credit
        using errcode = 'check_violation';
    end if;
    return null;
  end $$;

create constraint trigger journal_lines_balanced after insert on journal_lines
  deferrable initially deferred for each row execute function app_check_transaction_balanced();
create constraint trigger transactions_balanced after insert or update of version on transactions
  deferrable initially deferred for each row execute function app_check_transaction_balanced();

-- Every line of a version must carry the header's date and match its version.
create function app_journal_line_matches_header() returns trigger
  language plpgsql
  as $$
  declare h record;
  begin
    select version, txn_date into h from transactions where id = new.transaction_id;
    if new.version <> h.version or new.txn_date <> h.txn_date then
      raise exception 'Journal line version/date must match its transaction header' using errcode = 'check_violation';
    end if;
    return new;
  end $$;
create trigger journal_lines_match_header before insert on journal_lines
  for each row execute function app_journal_line_matches_header();

-- Closing date: block changes that touch a closed period unless the API verified the password.
create function app_enforce_closing_date() returns trigger
  language plpgsql
  as $$
  declare
    closed date;
    touched date;
  begin
    if coalesce(current_setting('app.closing_override', true), '') = 'on' then return new; end if;
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
create trigger transactions_closing_date before insert or update on transactions
  for each row execute function app_enforce_closing_date();
create trigger journal_lines_closing_date before insert on journal_lines
  for each row execute function app_enforce_closing_date();

-- ---------------------------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['accounts','terms','payment_methods','classes','locations','customers',
                           'vendors','items','transactions','journal_lines']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for all using (company_id = app_current_company_id()) with check (company_id = app_current_company_id())',
      t || '_tenant', t);
  end loop;
end $$;

grant select, insert, update on accounts, terms, payment_methods, classes, locations, customers, vendors, items, transactions to acct_app;
grant select, insert on journal_lines to acct_app;
