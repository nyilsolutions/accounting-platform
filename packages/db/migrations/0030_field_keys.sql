-- Phase 12c: field encryption keys wrapped by AWS KMS (envelope encryption, ADR 0029).
--
-- Each version is a random 256-bit data key, stored only in its wrapped (KMS-encrypted) form.
-- The API reads the wrapped keys at start and asks KMS to unwrap each version once; fields are
-- then encrypted in memory with the newest version (`v<version>:` prefix) and decrypted with
-- whichever version wrote them. The owner adds versions and re-encrypts rows
-- (`keys:rotate`); the app role can only read. Keys are global, not tenant data, so outside RLS.
create table field_keys (
  version         integer primary key check (version >= 1),
  provider        text not null check (provider in ('aws-kms', 'local-wrap')),
  kms_key_id      text check ((provider = 'aws-kms') = (kms_key_id is not null)),
  wrapped_key     text not null,
  created_at      timestamptz not null default now(),
  -- When every encrypted field had been rewritten with this version (keys:rotate).
  reencrypted_at  timestamptz
);
grant select on field_keys to acct_app;
