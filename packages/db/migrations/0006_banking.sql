-- Phase 4: banking.
--
-- Transfers post through the journal like every other transaction (ADR 0007). Everything else in
-- banking is bookkeeping around the journal, not part of it:
--   * bank_clearings: which transactions have cleared or been reconciled in a bank or credit card
--     account (current state; journal lines stay append-only);
--   * reconciliations: statement date, beginning/ending balance, status;
--   * bank feed: connections to an aggregator (Plaid), their accounts mapped to the chart of
--     accounts, imported files, and the raw bank transactions waiting "For Review";
--   * bank rules that categorize (and optionally add) feed transactions.

alter table transactions drop constraint transactions_txn_type_check;
alter table transactions add constraint transactions_txn_type_check check (txn_type in (
  'journal_entry', 'invoice', 'sales_receipt', 'credit_memo', 'refund_receipt', 'payment', 'deposit',
  'bill', 'vendor_credit', 'bill_payment', 'check', 'expense', 'cc_credit', 'transfer'));

-- ---------------------------------------------------------------------------------------------
-- Reconciliations and cleared status
-- ---------------------------------------------------------------------------------------------
create table reconciliations (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references companies (id) on delete cascade,
  account_id         uuid not null,
  statement_date     date not null,
  beginning_balance  numeric(19,4) not null,
  ending_balance     numeric(19,4) not null,
  status             text not null default 'in_progress' check (status in ('in_progress', 'completed', 'undone')),
  completed_at       timestamptz,
  completed_by       uuid references users (id),
  created_by         uuid references users (id),
  updated_by         uuid references users (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, account_id) references accounts (company_id, id)
);
-- One reconciliation in progress per account.
create unique index reconciliations_in_progress_key on reconciliations (company_id, account_id)
  where status = 'in_progress';
create index reconciliations_account_idx on reconciliations (company_id, account_id, statement_date);
create trigger reconciliations_touch before update on reconciliations for each row execute function app_touch_updated_at();

-- A transaction's lines on a bank or credit card account have cleared ('C') or been reconciled
-- ('R'). Absent row = uncleared.
create table bank_clearings (
  company_id         uuid not null,
  transaction_id     uuid not null,
  account_id         uuid not null,
  status             text not null check (status in ('cleared', 'reconciled')),
  reconciliation_id  uuid,
  updated_at         timestamptz not null default now(),
  primary key (transaction_id, account_id),
  foreign key (company_id, transaction_id) references transactions (company_id, id),
  foreign key (company_id, account_id) references accounts (company_id, id),
  foreign key (company_id, reconciliation_id) references reconciliations (company_id, id),
  check ((status = 'reconciled') = (reconciliation_id is not null))
);
create index bank_clearings_account_idx on bank_clearings (company_id, account_id, status);

-- ---------------------------------------------------------------------------------------------
-- Bank feeds: aggregator connections and their accounts
-- ---------------------------------------------------------------------------------------------
create table bank_feed_connections (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies (id) on delete cascade,
  provider          text not null check (provider in ('plaid', 'mock')),
  institution_name  text not null check (length(institution_name) <= 200),
  item_id           text not null check (length(item_id) <= 200),
  -- Encrypted with FieldEncryptor, AAD bank_connection:<id>:access_token. Never logged or audited.
  access_token_enc  text not null,
  sync_cursor       text,
  status            text not null default 'active' check (status in ('active', 'error', 'disconnected')),
  error_message     text check (length(error_message) <= 1000),
  last_synced_at    timestamptz,
  created_by        uuid references users (id),
  updated_by        uuid references users (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (company_id, id)
);
create unique index bank_feed_connections_item_key on bank_feed_connections (company_id, provider, item_id)
  where status <> 'disconnected';
create trigger bank_feed_connections_touch before update on bank_feed_connections for each row execute function app_touch_updated_at();

-- Aggregator webhooks arrive without a tenant context and name only the item. This returns the
-- company that owns an item, and nothing else, so the API can then work inside withTenant().
create function app_bank_connection_company(p_provider text, p_item_id text) returns uuid
  language sql stable security definer set search_path = public as $$
    select company_id from bank_feed_connections
     where provider = p_provider and item_id = p_item_id and status <> 'disconnected'
     limit 1
  $$;
revoke all on function app_bank_connection_company(text, text) from public;
grant execute on function app_bank_connection_company(text, text) to acct_app;

create table bank_feed_accounts (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null,
  connection_id        uuid not null,
  external_account_id  text not null check (length(external_account_id) <= 200),
  name                 text not null check (length(name) <= 200),
  mask                 text check (mask ~ '^[0-9A-Za-z]{0,8}$'),
  kind                 text not null check (kind in ('bank', 'credit_card', 'other')),
  -- The bank or credit card account in the chart of accounts it feeds. Null = not used.
  account_id           uuid,
  start_date           date,
  created_at           timestamptz not null default now(),
  unique (company_id, id),
  unique (connection_id, external_account_id),
  foreign key (company_id, connection_id) references bank_feed_connections (company_id, id) on delete cascade,
  foreign key (company_id, account_id) references accounts (company_id, id)
);
create unique index bank_feed_accounts_account_key on bank_feed_accounts (account_id) where account_id is not null;

-- Per bank/credit card account: saved CSV column mapping and the last balance the bank reported.
create table bank_account_settings (
  company_id         uuid not null,
  account_id         uuid not null,
  csv_mapping        jsonb,
  bank_balance       numeric(19,4),
  bank_balance_date  date,
  updated_at         timestamptz not null default now(),
  primary key (account_id),
  foreign key (company_id, account_id) references accounts (company_id, id)
);

-- ---------------------------------------------------------------------------------------------
-- Bank rules
-- ---------------------------------------------------------------------------------------------
create table bank_rules (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies (id) on delete cascade,
  name            text not null check (length(name) between 1 and 100),
  priority        integer not null default 100,
  direction       text not null default 'both' check (direction in ('in', 'out', 'both')),
  -- Bank/card accounts the rule applies to; empty = all.
  account_ids     uuid[] not null default '{}',
  match_all       boolean not null default true,
  -- [{ "field": "description" | "amount", "operator": "...", "value": "..." }], validated by the API.
  conditions      jsonb not null,
  action_kind     text not null check (action_kind in ('categorize', 'transfer', 'exclude')),
  set_account_id  uuid,
  set_vendor_id   uuid,
  set_customer_id uuid,
  set_class_id    uuid,
  set_memo        text check (length(set_memo) <= 1000),
  auto_add        boolean not null default false,
  is_active       boolean not null default true,
  created_by      uuid references users (id),
  updated_by      uuid references users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, set_account_id) references accounts (company_id, id),
  foreign key (company_id, set_vendor_id) references vendors (company_id, id),
  foreign key (company_id, set_customer_id) references customers (company_id, id),
  foreign key (company_id, set_class_id) references classes (company_id, id),
  check (action_kind = 'exclude' or set_account_id is not null),
  check (set_vendor_id is null or set_customer_id is null)
);
create unique index bank_rules_name_key on bank_rules (company_id, lower(name));
create trigger bank_rules_touch before update on bank_rules for each row execute function app_touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Imported bank transactions ("For Review")
-- ---------------------------------------------------------------------------------------------
create table bank_import_batches (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies (id) on delete cascade,
  account_id       uuid not null,
  source           text not null check (source in ('file', 'feed')),
  file_name        text check (length(file_name) <= 255),
  format           text check (format in ('ofx', 'csv', 'plaid', 'mock')),
  added_count      integer not null default 0,
  duplicate_count  integer not null default 0,
  created_by       uuid references users (id),
  created_at       timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, account_id) references accounts (company_id, id)
);

create table bank_feed_transactions (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  account_id      uuid not null,
  batch_id        uuid,
  -- FITID (OFX), transaction_id (Plaid) or a content hash (CSV): the duplicate check.
  external_id     text not null check (length(external_id) <= 200),
  posted_date     date not null,
  -- Money into the account is positive (deposit, card payment/refund); money out is negative.
  amount          numeric(19,4) not null check (amount <> 0),
  description     text not null check (length(description) <= 1000),
  payee           text check (length(payee) <= 200),
  check_number    text check (length(check_number) <= 30),
  status          text not null default 'for_review' check (status in ('for_review', 'added', 'matched', 'excluded')),
  -- The transaction it was added as or matched to.
  transaction_id  uuid,
  rule_id         uuid,
  updated_by      uuid references users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (company_id, id),
  unique (account_id, external_id),
  foreign key (company_id, account_id) references accounts (company_id, id),
  foreign key (company_id, batch_id) references bank_import_batches (company_id, id),
  foreign key (company_id, transaction_id) references transactions (company_id, id),
  foreign key (company_id, rule_id) references bank_rules (company_id, id) on delete set null (rule_id),
  check ((status in ('added', 'matched')) = (transaction_id is not null))
);
create index bank_feed_transactions_review_idx on bank_feed_transactions (company_id, account_id, status, posted_date);
create index bank_feed_transactions_txn_idx on bank_feed_transactions (transaction_id) where transaction_id is not null;
create trigger bank_feed_transactions_touch before update on bank_feed_transactions for each row execute function app_touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Row-Level Security and grants
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['reconciliations', 'bank_clearings', 'bank_feed_connections', 'bank_feed_accounts',
                           'bank_account_settings', 'bank_rules', 'bank_import_batches', 'bank_feed_transactions']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for all using (company_id = app_current_company_id()) with check (company_id = app_current_company_id())',
      t || '_tenant', t);
  end loop;
end $$;

grant select, insert, update, delete on reconciliations to acct_app;
grant select, insert, update, delete on bank_clearings, bank_feed_accounts, bank_account_settings,
  bank_rules, bank_feed_transactions to acct_app;
grant select, insert, update on bank_feed_connections, bank_import_batches to acct_app;
