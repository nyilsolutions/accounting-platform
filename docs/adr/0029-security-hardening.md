# ADR 0029: Security hardening for launch (Phase 12c)

- Status: Accepted
- Date: 2026-10-07

## Context

Before customers trust the platform with payroll, tax ids and bank numbers it needs a stated
security level, keys outside the application, scanning in CI, a way for customers to take
their data with them, and written policies an auditor can test against. The owner decided
(2026-10-07):

- **Keys:** envelope encryption with AWS KMS and one data key per version (not a KMS call per
  value).
- **Verification standard:** OWASP ASVS 4.0.3 Level 2.
- **Data export:** a full archive (CSV and JSON, with the attached files), owners only, built
  in the background, SSNs and bank numbers masked unless the owner re-authenticates, an emailed
  link, available for 7 days.
- **SOC 2 policies:** written now with placeholders (`[Company]`, `[Security Officer]`...) and a
  fill-in list.

## Decision

### 1. Field keys in KMS (envelope encryption)

- **A keyring in the database:** `field_keys` holds each data key version, wrapped (encrypted)
  by the KMS key `FIELD_KMS_KEY_ID`, with the provider and key id. The app role can only read
  it.
- **Unwrapped once:** at start-up the API and workers ask KMS to unwrap each version and keep
  the keys in memory. Each `GenerateDataKey`, `Encrypt` and `Decrypt` call carries an
  EncryptionContext (`app`, `purpose`, `version`), so a wrapped key can't be used as another.
- **Nothing else changes for values:** AES-256-GCM with a row-bound AAD (ADR 0004). Every value
  names its key version (`v<n>:`), so old values keep decrypting after a rotation. The 16-byte
  GCM tag length is enforced.
- **Providers:** `FIELD_KEY_PROVIDER` is `env` (one key from the environment; development and
  tests), `aws-kms` (production, required), or `local-wrap` (the same keyring wrapped by a local
  key; a stand-in for tests, refused in production). A keyring made by one provider is never
  read by another.
- **Rotation:** run as the database owner, `keys:rotate` adds a version (the first time it
  imports the old environment key as version 1, so existing values still decrypt; the public
  `.env.example` key is refused by its hash), the services restart, then `keys:reencrypt`
  rewrites every value still on an older version. `keys:status` counts values per version.
  `ENCRYPTED_COLUMNS` lists every encrypted column and its AAD; a test checks it against the
  schema so a new column can't be missed.
- **All AADs in one place** (`security/aad.ts`).
- **Signing is separate:** download links and OAuth state are signed with `SIGNING_KEY`, not a
  field key.
- **Files:** on S3, objects use S3 server-side encryption (SSE-KMS with `S3_SSE=aws:kms` and `S3_KMS_KEY_ID`).
  Local storage encrypts each file with its own data key, wrapped by the field encryptor, as do
  data exports.

### 2. ASVS Level 2

Three reviews read every chapter against the code (authentication, sessions and access; input,
files, API and configuration; architecture, cryptography, errors, data and business logic). We
verified each finding before fixing it, and each fix has a test. The checklist, with where each
requirement is met and what is left, is `docs/security/asvs-l2.md`; the threat model is
`docs/security/threat-model.md`. The main changes:

- **Sign-in:**
  - separate, atomic counters for password and MFA failures;
  - TOTP codes claimed once, with replays audited and emailed;
  - passwords hashed with a pepper (`PASSWORD_PEPPER`, re-made at the next sign-in);
  - breached passwords refused (Pwned Passwords range API, k-anonymity, padded; it fails open
    and logs if the service is down);
  - 120-bit recovery codes that can be renewed;
  - change password, which signs out other sessions;
  - emails on security events (password, MFA, recovery codes, new device, lockout).
- **Sessions:**
  - 30 minutes idle and 12 hours in all (enforced in production);
  - a Security page to see and end sessions;
  - `Clear-Site-Data` on sign-out.
- **Step-up:**
  - sensitive actions need an MFA code from the last `STEP_UP_MINUTES` (5): revealing SSNs and
    EINs, the SSN wage export, direct deposit, EFTPS enrollment, connecting payments, changing
    members and invitations, approving worker changes, the full-data export;
  - the API answers `403 STEP_UP_REQUIRED` and the web asks for a code and retries.
- **Access:**
  - Desktop agent keys stop when their creator can no longer manage migrations;
  - portal lists are scoped by permission;
  - customer portal links last 10 minutes, at most one a minute, and inactive customers or a
    changed email end the customer's access.
- **Input and files:**
  - zip bomb caps;
  - the download extension must match the detected type;
  - compressed request bodies and unread body types get 415;
  - CSV cells are formula-safe;
  - linear OFX and IIF parsing;
  - QuickBooks download links checked (SSRF);
  - NUL characters get a 400.
- **Headers and configuration:**
  - `no-store` everywhere;
  - a nonce Content Security Policy with `strict-dynamic` and HSTS on every page (Next.js
    `proxy.ts`; pages render per request so Next can put the nonce on its scripts);
  - JSON answers are attachments;
  - production refuses to start without TLS to Postgres (`sslmode=verify-full`), https
    endpoints, clamd beside the API, or with pretty logs.
- **Errors and logging:**
  - generic messages for database and network errors;
  - last-resort handlers for unhandled rejections (log and continue) and uncaught exceptions
    (log and exit);
  - security events (refused access, unknown-account sign-ins, rejected input) logged with ids
    and field paths only.
- **Business logic:**
  - liability payments take a per-company advisory lock;
  - the closing date password locks after 5 wrong tries in 15 minutes, each failure an audit
    row;
  - a pay link starts at most 10 checkouts an hour.
- **Retention:**
  - the document purge also clears extraction results and the search index;
  - decided direct-deposit requests drop their encrypted bank numbers (a trigger);
  - a daily `security.cleanup` job deletes sessions, customer portal links and unaccepted
    invitations 30 days after they end.

### 3. Scanning in CI

A `Security` workflow on every pull request and weekly:

- CodeQL (security-extended) for TypeScript and C#;
- `pnpm audit` on production dependencies (high and above fail the build; everything is
  reported);
- vulnerable NuGet packages in the Desktop agent;
- gitleaks over the history, with a reviewed `.gitleaksignore` for test fixtures.

Dependabot opens updates for npm, NuGet and actions. Every action is pinned to a commit and
workflows have read-only tokens.

### 4. Company data export

- **Who:** owners only (`POST /companies/:id/data-exports`). One runs at a time.
- **How:** the `company.export` job builds one ZIP:
  - `csv/` and `json/`: every table with a `company_id` (found from the schema, so new tables
    are included), plus the company and its members;
  - `files/`: the current version of every active, clean document;
  - a README.
- **Never exported:** tables that hold credentials or importer staging (`EXCLUDED_TABLES`, each
  checked to exist), and columns that are hashes, encrypted values, tokens, secrets, storage
  keys or the search index.
- **Sensitive values:** SSNs, EINs, TINs and bank numbers are decrypted and shown as their last
  4 digits, or in full when the owner asks with a fresh MFA code. Downloading such an export
  needs a fresh code too.
- **Storage:** the archive is stored like a document (`data_exports.key_enc`, in the rotation
  registry). The owner is emailed a link to Settings > Export all data, never the file. The
  daily `company.export.expire` job deletes it after 7 days. Requesting, finishing, downloading
  and expiring are audited.

### 5. Policies

`docs/policies/` holds the SOC 2 policy set mapped to the Trust Services Criteria:

- the information security program (the GLBA Safeguards Rule's written program);
- access control, change management and secure development;
- encryption and key management, data classification and retention;
- logging and monitoring;
- incident response, business continuity and disaster recovery;
- vendor management, risk assessment, acceptable use and personnel security.

Organization-specific values are placeholders, listed in its README.

## Consequences

- Production needs `FIELD_KEY_PROVIDER=aws-kms` with a KMS key, `SIGNING_KEY`,
  `PASSWORD_PEPPER`, `PASSWORD_BREACH_CHECK=hibp`, `sslmode=verify-full`, https endpoints and
  JSON logs, or it doesn't start. 12d supplies them from Secrets Manager.
- Rotating keys is an operator task with a restart in the middle. Values on older versions stay
  readable until `keys:reencrypt`.
- Every page renders per request (no static pages), the price of a nonce CSP. Pages are
  client-rendered apps, so the cost is small.
- People are asked for an MFA code more often. Five minutes covers a run of sensitive actions.
- A data export is built in memory. A very large company's archive (many large files) may need
  streaming to S3 in parts (question 97).
- Accepted for now, each an open question:
  - WebAuthn (89);
  - registration revealing existing accounts (90);
  - storage quotas (91);
  - an SBOM per release (92);
  - account and company deletion (93);
  - signing the Desktop agent (94);
  - parsers in their own process (95);
  - the load balancer's forwarded IP (96).
