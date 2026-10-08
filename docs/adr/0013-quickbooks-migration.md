# ADR 0013: QuickBooks migration (Phase 6)

- Status: Accepted
- Date: 2026-09-29

## Context

Phase 6 of the master plan brings a company over from QuickBooks:

- **QuickBooks Online**: OAuth, every list and transaction, attachments, and changes made after
  the first pull.
- **QuickBooks Desktop**: an agent on the client's PC reads the company file through Intuit's
  SDK. The `.QBW` file itself is never parsed.
- **IIF files and CSV exports**, with column mapping and a preview.
- **A Migration Report** that ties the imported books out to QuickBooks' own figures, year by
  year. A migration is complete only when every difference is zero, or when an owner or admin
  accepts the differences in writing.

The sources disagree on almost everything: ids, names, amounts, and how a document's GL lines
are recorded. The import must also be safe to run again while the client keeps working in
QuickBooks until the switch.

## Decision

### One pipeline, three stages

1. **Raw:** QuickBooks Online objects and Desktop agent uploads are stored as received in
   `migration_raw`, one row per (migration, source entity, source id). IIF and CSV files are not
   kept; they are parsed straight to stage 2.
2. **Canonical:** every source maps to one shared format, `CANONICAL_SCHEMAS` in
   `packages/shared/src/migration.ts`:
   - one record per list entry or transaction, in `migration_records`, with a payload hash,
     warnings and a status (pending, imported, skipped, error);
   - references to other records by source id, `name:<full name>` (file sources), or
     `role:<system role>` (for example the A/R account).

   Each transaction may carry `sourceGl`: its lines as QuickBooks posted them.

3. **Books:** the import engine (`migration/import-engine.ts`) creates each record through the
   normal services, using new `saveInTx`, `createInTx` and `updateInTx` variants that take the
   engine's transaction. So imported invoices, bills and payments are ordinary documents: they
   post through `PostingService` (ADR 0007), keep the A/R and A/P subledgers tied, and are
   validated like anything a person enters.

### Idempotent reruns

- `migration_map` maps (company, source key, entity type, source id) to the record created
  here, with the payload hash that produced it:
  - The source key is `qbo:<realm id>` for QuickBooks Online and `file:<migration id>` otherwise.
  - An unchanged record is skipped.
  - A changed record updates what was created.
  - A transaction deleted in QuickBooks is deleted here through `PostingService`, so its
    history is kept (ADR 0007). A deleted estimate or purchase order is closed.
  - `acct_app` cannot delete map rows.
- **Order:**
  - Lists come first, parents before children.
  - Transactions follow in date order; on the same date, documents come before the payments
    and deposits that use them (`TXN_PRIORITY`). Deletions run in reverse.
  - A reference to a record that is still pending is retried in a later pass.
- Each record is imported in its own transaction, so one bad record doesn't stop the run. It is
  marked as an error with a readable reason.
- A run holds a lease (10 minutes, renewed as it goes), so two runs can't overlap.
- **Empty company:** the first run refuses a company that already has transactions not created
  by an import (`COMPANY_NOT_EMPTY`), so imported history is never mixed with live entries.
- **Finalize:**
  - Lists inactive in QuickBooks are deactivated.
  - Accounts from the default chart that nothing uses are deactivated.
  - Imported attachments are matched to records.

### Same GL effect, or a journal entry

The rule: **every imported transaction posts exactly what QuickBooks posted.**

- When the document built here posts different lines from `sourceGl` (for example inventory
  cost of goods sold, or a rounding difference), a companion journal entry (`<source id>#gl`)
  posts the difference. It never touches A/R or A/P, so open items still sum to the control
  accounts.
- Some documents can't be represented here:
  - a second A/R or A/P account;
  - a line on an account the document type forbids;
  - cash back on a deposit;
  - a negative total;
  - a payment applied to something other than a bill or invoice.

  These are imported as journal entries with the same lines, preferring `sourceGl`, and carry a
  warning.

- Payment discounts on Desktop become a credit memo or vendor credit applied with the payment,
  as QuickBooks records them.

### Sources

- **QuickBooks Online:**
  - `IntuitQboApi` handles:
    - OAuth 2.0, with only the `com.intuit.quickbooks.accounting` scope;
    - query paging;
    - Change Data Capture;
    - reports;
    - attachment downloads.

    It retries throttling and server errors, and uses minor version 75.

  - The OAuth `state` is HMAC-signed and bound to the user, company and migration. Tokens are
    stored with `FieldEncryptor` (ADR 0004), with an AAD naming the connection and the token.
    Disconnecting revokes them.
  - **Change sync:** Change Data Capture reaches back 30 days. Older pulls fall back to a full
    pull, which is safe because of the map.
  - Development and tests use `QBO_ENVIRONMENT=mock`: a fake Intuit API serves a demo company
    (`sources/qbo/mock-company.ts`) and computes its reports from the fixture's GL. No test uses
    the network.
- **QuickBooks Desktop agent** (`apps/desktop-agent`, C#/.NET 8):
  - A Windows wizard asks for the site address, a pairing key and the years to bring over. The
    key is shown once in the web, stored as a SHA-256 hash, and expires after
    `MIGRATION_AGENT_KEY_DAYS`.
  - It talks to QuickBooks through qbXML 13.0 (`QBXMLRP2`, late-bound COM) and uploads in
    batches to `/api/agent/v1`. The routes use the key, not a session, and are exempt from the
    CSRF check.
  - A checkpoint file lets an interrupted upload resume where it stopped.
  - It uploads:
    - the trial balance per fiscal year end;
    - A/R and A/P agings;
    - the Journal report, which gives each transaction's GL lines;
    - the Attach folder.
  - The portable parts (qbXML, API client, checkpoints, runner) are tested on Linux in CI. The
    Windows build is published as a CI artifact.
- **IIF:** Lists and transactions, including Windows-1252 text. A transaction's split lines are
  its `sourceGl`, and the GL classifier (`sources/gl-classifier.ts`) recognizes the document
  type. Anything it can't name stays a journal entry with the same lines.
- **CSV:** chart of accounts, customers, vendors, items, opening balances, invoices, bills,
  journal entries and GL detail, plus a trial balance and agings for the check.
  - Columns are mapped by header name (`CSV_KIND_SPECS`, with aliases) and can be changed.
  - The web previews what the API will stage; the API parses the file again.

### Attachments

- **QuickBooks Online:** attachments are downloaded and stored as documents (ADR 0012):
  scanned, encrypted, source `import`, with QuickBooks' note and original date.
- **Desktop:** Attach folder files are uploaded by the agent the same way.
- **Matching:**
  - A file linked in QuickBooks is attached to the imported record.
  - Otherwise it is scored against transactions by QuickBooks id in the name, then number,
    amount, date and party. A clear winner (score ≥ 80 and 20 ahead of the next) is attached
    automatically.
  - The rest wait on **Match attachments**, with suggestions, search, and **set aside**.

### Sensitive fields

- Tax ids, SSNs, birth dates, pay details, and bank and card numbers are never imported.
- The agent doesn't upload them, and the server drops them (`withoutSensitive`) before
  anything reaches `migration_raw`.
- So staging never holds a value that rule 4 would require to be encrypted.

### Migration Report (tie-out)

- **Per fiscal year end** in the imported range, and at the latest transaction date:
  - **Trial balance by account.** Balance sheet accounts are compared cumulatively, and P&L
    accounts for the year. Retained earnings includes prior years' net income, as QuickBooks
    shows it.
  - **Balance sheet and P&L totals.**
  - **Bank and credit card balances.**
  - **A/R and A/P agings by customer and vendor.**
- **QuickBooks' figures:**
  - from its own reports (QuickBooks Online, the Desktop agent, uploaded CSVs);
  - or, when every transaction carried `sourceGl` (IIF, GL detail CSV), computed from those
    lines.
- **Drill-down:** any account's difference lists the transactions behind it on both sides.
- **Completion:** needs zero differences and no record left pending or in error. Otherwise it
  needs `acceptDifferences` from an owner or admin, with a note. The report as accepted is stored on the migration and audited. After that, the
  migration is read-only.

### Permissions and tenancy

- `migration.manage` (owner, admin, accountant) covers everything except accepting
  differences.
- Every new table has `company_id` and RLS. The agent key is resolved through a
  `security definer` function, like Plaid webhooks and email-in.

## Consequences

- Imported history is indistinguishable from history entered here: every report, register,
  reconciliation and subledger works on it, and it can be edited like anything else. The trade-off
  is that anything the services refuse must become a journal entry, and says so in a warning.
- Reruns are cheap and safe, so a firm can import early, keep the client in QuickBooks, sync,
  and switch on a chosen day.
- A new source only needs a mapper to the canonical format; the engine, tie-out and UI are
  shared.
- The Desktop agent is a separate Windows program that must be signed and distributed (see open
  questions).
- The importers are verified against synthetic companies only. Real QuickBooks Online sandbox,
  Desktop and IIF samples must be added as fixtures before the first client migration (see open
  questions).
