-- Phase 6: QuickBooks migration (ADR 0013).
--
-- A migration brings one QuickBooks company (Online, Desktop, or IIF/CSV files) into a company:
--
--   raw source records  →  canonical records  →  the company's lists and transactions
--   (QBO / Desktop JSON)    (one format for        (created through the normal services, so every
--                            every source)          rule, audit row and posting applies)
--
-- migration_map remembers which record each source id became, so a rerun or a delta sync
-- updates instead of duplicating. migration_reports hold the source's own figures (trial
-- balance, A/R and A/P aging) that the tie-out report compares against the imported books.

create table migrations (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references companies (id) on delete cascade,
  source                text not null check (source in ('qbo', 'desktop', 'iif', 'csv')),
  -- Identifies the source company across migrations: 'qbo:<realm id>', 'desktop:<file id>', or
  -- 'file:<migration id>' for IIF and CSV files (which carry no stable company id).
  source_key            text not null check (length(source_key) between 1 and 200),
  name                  text not null check (length(name) between 1 and 200),
  status                text not null default 'staging'
                          check (status in ('staging', 'importing', 'imported', 'complete')),
  -- The date the source's reports are as of (usually the last day imported).
  as_of                 date,
  -- A running import holds a lease; a new run may start once it has expired.
  lease_until           timestamptz,
  last_run_at           timestamptz,
  last_error            text check (length(last_error) <= 2000),
  qbo_connection_id     uuid,
  completed_at          timestamptz,
  completed_by          uuid references users (id),
  accepted_differences  boolean,
  acceptance_note       text check (length(acceptance_note) <= 2000),
  -- The tie-out report as it stood when the migration was completed.
  completion_report     jsonb,
  created_by            uuid references users (id),
  updated_by            uuid references users (id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (company_id, id),
  check ((status = 'complete') = (completed_at is not null))
);
create index migrations_company_idx on migrations (company_id, created_at desc);
create trigger migrations_touch before update on migrations for each row execute function app_touch_updated_at();

-- What QuickBooks Online and the Desktop agent sent, as received. "Prepare" maps these to
-- canonical records with the whole company in view (an invoice line needs its item's type).
create table migration_raw (
  company_id     uuid not null,
  migration_id   uuid not null,
  source_entity  text not null check (source_entity ~ '^[A-Za-z]{1,60}$'),
  source_id      text not null check (length(source_id) between 1 and 200),
  data           jsonb not null,
  deleted        boolean not null default false,
  received_at    timestamptz not null default now(),
  primary key (migration_id, source_entity, source_id),
  foreign key (company_id, migration_id) references migrations (company_id, id) on delete cascade
);

-- One canonical record per source record (see packages/shared/src/migration.ts).
create table migration_records (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null,
  migration_id   uuid not null,
  entity_type    text not null check (entity_type in (
                   'account', 'class', 'location', 'term', 'payment_method', 'customer', 'vendor', 'item',
                   'invoice', 'sales_receipt', 'credit_memo', 'refund_receipt', 'payment', 'deposit',
                   'bill', 'vendor_credit', 'check', 'expense', 'cc_credit', 'bill_payment', 'transfer',
                   'journal_entry', 'estimate', 'purchase_order', 'attachment')),
  source_id      text not null check (length(source_id) between 1 and 200),
  -- The QuickBooks name for what this was ("Invoice", "CHECK", "Paycheck", …).
  source_type    text not null check (length(source_type) between 1 and 60),
  txn_date       date,
  number         text check (length(number) <= 60),
  label          text check (length(label) <= 300),
  payload        jsonb not null,
  payload_hash   text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  -- The source deleted it (delta sync); the imported record is deleted too.
  deleted        boolean not null default false,
  status         text not null default 'pending' check (status in ('pending', 'imported', 'skipped', 'error')),
  message        text check (length(message) <= 2000),
  -- Notes about changes made so the record fits (a renamed duplicate, a dropped field, …).
  warnings       text[] not null default '{}',
  target_id      uuid,
  imported_hash  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (company_id, id),
  unique (migration_id, entity_type, source_id),
  foreign key (company_id, migration_id) references migrations (company_id, id) on delete cascade
);
create index migration_records_status_idx on migration_records (migration_id, status, entity_type);
create index migration_records_date_idx on migration_records (migration_id, txn_date);
create trigger migration_records_touch before update on migration_records for each row execute function app_touch_updated_at();

-- Source id → the record it became, across migrations of the same source company.
create table migration_map (
  company_id    uuid not null references companies (id) on delete cascade,
  source_key    text not null,
  entity_type   text not null,
  source_id     text not null,
  target_id     uuid not null,
  -- The canonical payload hash last imported, so a rerun leaves unchanged records alone.
  payload_hash  text not null,
  migration_id  uuid not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (company_id, source_key, entity_type, source_id),
  foreign key (company_id, migration_id) references migrations (company_id, id) on delete cascade
);
create index migration_map_target_idx on migration_map (company_id, target_id);

-- The source's own figures, for the tie-out: from QuickBooks itself, or uploaded exports.
-- Rows: [{ "ref": source id or null, "name": text, "amount": signed decimal }], where a trial
-- balance amount is debit − credit and an aging amount is the open balance.
create table migration_reports (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  migration_id  uuid not null,
  kind          text not null check (kind in ('trial_balance', 'ar_aging', 'ap_aging')),
  as_of         date not null,
  origin        text not null check (origin in ('source', 'upload')),
  rows          jsonb not null,
  created_at    timestamptz not null default now(),
  unique (migration_id, kind, as_of),
  foreign key (company_id, migration_id) references migrations (company_id, id) on delete cascade
);

-- Files from QuickBooks (QBO attachables, the Desktop Attach folder) and what they were
-- attached to. Unmatched files wait on the "Match attachments" screen.
create table migration_attachments (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null,
  migration_id        uuid not null,
  document_id         uuid not null,
  source_path         text not null check (length(source_path) between 1 and 1000),
  status              text not null check (status in ('matched', 'unmatched', 'ignored')),
  -- [{ entityType, entityId, label, score, reason }], best first.
  suggestions         jsonb not null default '[]',
  matched_by          text check (matched_by in ('source', 'auto', 'user')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (company_id, id),
  unique (migration_id, source_path),
  foreign key (company_id, migration_id) references migrations (company_id, id) on delete cascade,
  foreign key (company_id, document_id) references documents (company_id, id)
);
create index migration_attachments_status_idx on migration_attachments (migration_id, status);
create trigger migration_attachments_touch before update on migration_attachments for each row execute function app_touch_updated_at();

-- The Desktop agent signs in with a pairing key shown once in the web app (the agent cannot do
-- the browser's MFA sign-in). Only a SHA-256 hash is stored.
create table migration_agent_keys (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  migration_id  uuid not null,
  key_hash      text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  key_prefix    text not null check (key_prefix ~ '^[A-Za-z0-9]{4,12}$'),
  expires_at    timestamptz not null,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_by    uuid not null references users (id),
  created_at    timestamptz not null default now(),
  foreign key (company_id, migration_id) references migrations (company_id, id) on delete cascade
);

-- The agent's requests carry only the key. This returns what the key may act on, and nothing
-- else, so the API can then work inside withTenant() as the user who created the key.
create function app_migration_agent_key(p_hash text)
  returns table (key_id uuid, company_id uuid, migration_id uuid, user_id uuid)
  language sql stable security definer set search_path = public as $$
    select id, company_id, migration_id, created_by from migration_agent_keys
     where key_hash = p_hash and revoked_at is null and expires_at > now()
  $$;
revoke all on function app_migration_agent_key(text) from public;
grant execute on function app_migration_agent_key(text) to acct_app;

-- QuickBooks Online connections (Intuit OAuth 2.0). Tokens are encrypted with FieldEncryptor,
-- AAD qbo_connection:<id>:access_token / :refresh_token. Never logged or audited.
create table qbo_connections (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references companies (id) on delete cascade,
  environment         text not null check (environment in ('sandbox', 'production', 'mock')),
  realm_id            text not null check (realm_id ~ '^[0-9A-Za-z]{1,40}$'),
  company_name        text check (length(company_name) <= 200),
  access_token_enc    text not null,
  refresh_token_enc   text not null,
  access_expires_at   timestamptz not null,
  refresh_expires_at  timestamptz,
  status              text not null default 'active' check (status in ('active', 'error', 'disconnected')),
  error_message       text check (length(error_message) <= 1000),
  -- The server time of the last full pull or delta sync; the next delta asks for changes since.
  synced_through      timestamptz,
  created_by          uuid references users (id),
  updated_by          uuid references users (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (company_id, id)
);
create unique index qbo_connections_realm_key on qbo_connections (company_id, environment, realm_id)
  where status <> 'disconnected';
create trigger qbo_connections_touch before update on qbo_connections for each row execute function app_touch_updated_at();

alter table migrations
  add foreign key (company_id, qbo_connection_id) references qbo_connections (company_id, id);

-- Documents brought over from QuickBooks keep the date they were attached there.
alter table documents drop constraint documents_source_check;
alter table documents add constraint documents_source_check
  check (source in ('upload', 'camera', 'email', 'system', 'import'));
alter table documents add column original_created_at timestamptz;

do $$
declare t text;
begin
  foreach t in array array['migrations', 'migration_raw', 'migration_records', 'migration_map',
                           'migration_reports', 'migration_attachments', 'migration_agent_keys',
                           'qbo_connections']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for all using (company_id = app_current_company_id()) with check (company_id = app_current_company_id())',
      t || '_tenant', t);
  end loop;
end $$;

-- Staging data can be discarded before anything is imported; the map is kept for good.
grant select, insert, update, delete on migrations, migration_raw, migration_records,
  migration_reports, migration_attachments to acct_app;
grant select, insert, update on migration_map, migration_agent_keys, qbo_connections to acct_app;
