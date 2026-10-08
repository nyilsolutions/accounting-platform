-- Phase 5: documents and supporting files.
--
-- A document is a named file with versions (never overwritten). Bytes live in object storage;
-- the database keeps metadata, scan status, extracted text for search, links to the records the
-- document supports, receipt extraction results, and per-company settings (retention, email-in).

create table document_settings (
  company_id       uuid primary key references companies (id) on delete cascade,
  retention_years  integer not null default 7 check (retention_years between 1 and 100),
  -- The local part of the company's email-in address (<token>@<INBOUND_EMAIL_DOMAIN>).
  inbox_token      text not null unique check (inbox_token ~ '^[a-z0-9]{12,40}$'),
  inbox_enabled    boolean not null default true,
  updated_by       uuid references users (id),
  updated_at       timestamptz not null default now()
);
create trigger document_settings_touch before update on document_settings for each row execute function app_touch_updated_at();

create table document_folders (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies (id) on delete cascade,
  parent_id   uuid,
  name        text not null check (length(name) between 1 and 100),
  created_by  uuid references users (id),
  updated_by  uuid references users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, parent_id) references document_folders (company_id, id),
  check (parent_id is null or parent_id <> id)
);
create unique index document_folders_name_key
  on document_folders (company_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create trigger document_folders_touch before update on document_folders for each row execute function app_touch_updated_at();

create table documents (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies (id) on delete cascade,
  folder_id        uuid,
  name             text not null check (length(name) between 1 and 255),
  source           text not null default 'upload' check (source in ('upload', 'camera', 'email', 'system')),
  email_from       text check (length(email_from) <= 320),
  email_subject    text check (length(email_subject) <= 500),
  tags             text[] not null default '{}',
  note             text check (length(note) <= 4000),
  current_version  integer not null default 1,
  -- Receipts and bills waiting to be turned into transactions ("inbox").
  inbox_status     text check (inbox_status in ('new', 'done')),
  status           text not null default 'active' check (status in ('active', 'deleted')),
  deleted_at       timestamptz,
  deleted_by       uuid references users (id),
  search_vector    tsvector,
  created_by       uuid references users (id),
  updated_by       uuid references users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, folder_id) references document_folders (company_id, id),
  check ((status = 'deleted') = (deleted_at is not null)),
  check (cardinality(tags) <= 20)
);
create index documents_company_idx on documents (company_id, status, created_at desc);
create index documents_folder_idx on documents (company_id, folder_id) where status = 'active';
create index documents_inbox_idx on documents (company_id, inbox_status) where inbox_status = 'new';
create index documents_search_idx on documents using gin (search_vector);
create index documents_tags_idx on documents using gin (tags);
create trigger documents_touch before update on documents for each row execute function app_touch_updated_at();

create table document_versions (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null,
  document_id      uuid not null,
  version          integer not null check (version >= 1),
  file_name        text not null check (length(file_name) between 1 and 255),
  -- Detected from the bytes, not trusted from the browser.
  content_type     text not null,
  size_bytes       bigint not null check (size_bytes > 0),
  sha256           text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key      text not null,
  -- Local storage: the per-file data key, wrapped with FieldEncryptor (AAD document_version:<id>).
  key_enc          text,
  scan_status      text not null default 'pending' check (scan_status in ('pending', 'clean', 'infected', 'error')),
  scan_detail      text check (length(scan_detail) <= 500),
  extracted_text   text,
  -- Bytes removed after the retention period of a deleted document; the metadata stays.
  purged_at        timestamptz,
  uploaded_by      uuid references users (id),
  created_at       timestamptz not null default now(),
  unique (company_id, id),
  unique (document_id, version),
  foreign key (company_id, document_id) references documents (company_id, id)
);
create index document_versions_document_idx on document_versions (document_id, version desc);
create index document_versions_sha_idx on document_versions (company_id, sha256);

-- The records a document supports. entity_id is checked by the API against entity_type.
create table document_links (
  company_id   uuid not null,
  document_id  uuid not null,
  entity_type  text not null check (entity_type in (
    'transaction', 'customer', 'vendor', 'item', 'account', 'reconciliation', 'estimate', 'purchase_order')),
  entity_id    uuid not null,
  created_by   uuid references users (id),
  created_at   timestamptz not null default now(),
  primary key (document_id, entity_type, entity_id),
  foreign key (company_id, document_id) references documents (company_id, id)
);
create index document_links_entity_idx on document_links (company_id, entity_type, entity_id);

-- Receipt and bill capture: what was read from a document version.
create table document_extractions (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  document_id     uuid not null,
  version         integer not null,
  provider        text not null check (provider in ('anthropic', 'heuristic')),
  status          text not null check (status in ('done', 'failed')),
  result          jsonb,
  error           text check (length(error) <= 1000),
  -- The expense or bill created from it.
  transaction_id  uuid,
  created_by      uuid references users (id),
  created_at      timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, document_id) references documents (company_id, id),
  foreign key (company_id, transaction_id) references transactions (company_id, id),
  check ((status = 'done') = (result is not null))
);
create index document_extractions_document_idx on document_extractions (document_id, created_at desc);

-- Learning from corrections: the vendor (and category) chosen for a name read from receipts.
create table vendor_aliases (
  company_id  uuid not null,
  alias       text not null check (alias ~ '^[A-Z0-9 ]{1,200}$'),
  vendor_id   uuid not null,
  account_id  uuid,
  updated_at  timestamptz not null default now(),
  primary key (company_id, alias),
  foreign key (company_id, vendor_id) references vendors (company_id, id),
  foreign key (company_id, account_id) references accounts (company_id, id)
);

-- Inbound email arrives without a tenant context and names only the address. This returns the
-- company that owns an enabled inbox token, and nothing else.
create function app_document_inbox_company(p_token text) returns uuid
  language sql stable security definer set search_path = public as $$
    select company_id from document_settings where inbox_token = lower(p_token) and inbox_enabled
  $$;
revoke all on function app_document_inbox_company(text) from public;
grant execute on function app_document_inbox_company(text) to acct_app;

do $$
declare t text;
begin
  foreach t in array array['document_settings', 'document_folders', 'documents', 'document_versions',
                           'document_links', 'document_extractions', 'vendor_aliases']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for all using (company_id = app_current_company_id()) with check (company_id = app_current_company_id())',
      t || '_tenant', t);
  end loop;
end $$;

-- Documents are never deleted from the database (soft delete; bytes purged after retention).
grant select, insert, update on document_settings, documents, document_versions, document_extractions to acct_app;
grant select, insert, update, delete on document_folders, document_links, vendor_aliases to acct_app;
