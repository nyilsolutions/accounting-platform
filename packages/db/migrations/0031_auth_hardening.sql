-- Phase 12c: authentication hardening from the ASVS Level 2 review (ADR 0029).
--
-- Failed MFA codes are counted separately from failed passwords, so a correct password can no
-- longer clear the MFA count (which let anyone with a password guess codes without being
-- locked out). Both counters are incremented atomically by the API.
alter table users
  add column mfa_failed_count integer not null default 0 check (mfa_failed_count >= 0),
  -- The hash was made with the server-side pepper (PASSWORD_PEPPER); older hashes are re-made
  -- with it at the next successful sign-in.
  add column password_peppered boolean not null default false,
  add column password_changed_at timestamptz;
