# ADR 0004: Field-level encryption for sensitive data

- Status: Accepted (local key); KMS provider pending
- Date: 2026-09-29

## Decision

- Sensitive fields are encrypted in the application before storage. This covers EIN/SSN/TIN, bank
  account and routing numbers, MFA secrets, and third-party tokens (Plaid, Intuit).
- The algorithm is AES-256-GCM with a random 96-bit IV. The format is
  `v<keyVersion>:<iv>:<tag>:<ciphertext>`.
- **Additional authenticated data (AAD)** binds each value to its row and field
  (e.g. `company:<id>:ein`), so a ciphertext copied to another row fails to decrypt.
- Key versions allow rotation: old versions stay decryptable and new writes use the current version.
- Where display or search needs it, a non-sensitive projection is stored alongside (e.g.
  `ein_last4`).
- Reveal is a separate, permission-checked endpoint (`company.sensitive.reveal`), and every reveal
  is audited.

## Pending

The Phase 0 implementation (`LocalAesGcmEncryptor`) uses a key from the environment. Before
production, add a KMS envelope-encryption provider (AWS KMS / GCP KMS / Azure Key Vault)
implementing the same `FieldEncryptor` interface, plus a re-encryption job for key rotation.
