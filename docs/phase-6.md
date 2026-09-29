# Phase 6: QuickBooks migration

## Delivered

- **Import hub** (`g i`, permission `migration.manage`):
  - Start a migration from **QuickBooks Online**, **QuickBooks Desktop**, **IIF files** or **CSV
    and Excel exports**. Several sources can be combined in one company.
  - Each migration shows what was gathered by type, every record with its status and warnings
    (filter and search), and **Run the import**.
  - A migration can be discarded until it is complete.
- **QuickBooks Online connector:**
  - **Connect** with Intuit's sign-in (OAuth 2.0; accounting scope only; tokens encrypted).
  - **Pull** brings over:
    - the chart of accounts, classes, locations, terms and payment methods;
    - customers and jobs, vendors, and items (including bundles);
    - estimates, invoices, sales receipts, credit memos, refunds, payments, deposits;
    - checks, expenses and card credits, purchase orders, bills, vendor credits, bill payments;
    - transfers and journal entries;
    - **attachments**, with their file name, note and date;
    - the trial balance, balance sheet, P&L and agings for the check.
  - **Sync changes since the last pull** uses Change Data Capture. Run the import again and only
    what changed is created, updated or deleted, so clients keep working in QuickBooks until the
    switch.
- **QuickBooks Desktop agent** (`apps/desktop-agent`, Windows, .NET 8):
  - A wizard asks for the site address, a **pairing key** created in the web (shown once; expires
    after 7 days) and the years to bring over.
  - It reads the company file through Intuit's SDK (qbXML; the `.QBW` is never parsed) and
    uploads lists, transactions, the Journal report, the trial balance per year end and the
    agings, in batches that **resume** after an interruption.
  - It uploads the **Attach folder**. Files are linked to their transactions when QuickBooks
    recorded the link, or matched automatically.
  - **Opening balances:** years before the first one chosen come in as an opening journal
    entry, taken from the trial balance and agings the day before, instead of the full history.
- **IIF importer:**
  - Lists and transactions from QuickBooks' IIF exports, previewed before they are added.
  - Each transaction's split lines are kept, so the books are checked against the file's own GL.
- **CSV importer:**
  - Files: chart of accounts, customers, vendors, items, opening balances, invoices, bills,
    journal entries, GL detail, and a trial balance and agings for the check.
  - The **column mapping** is guessed from the headers and can be changed. A **preview** shows
    what will be added and which rows can't be read.
- **Imported records are ordinary records:**
  - They post through the ledger like anything entered here, so every report, register,
    reconciliation and subledger works on them, and they can be edited.
  - Anything the ledger can't represent (a second A/R account, cash back on a deposit, …) comes
    in as a journal entry with the same lines and a warning.
  - Differences in cost of goods sold or rounding are posted by a companion entry, so each
    transaction posts what QuickBooks posted.
- **Migration Report:**
  - For each fiscal year end and the latest date, it compares with QuickBooks:
    - the trial balance by account;
    - balance sheet and P&L totals;
    - bank and card balances;
    - A/R and A/P aging by customer and vendor.
  - **Drill into** any account to see the transactions on both sides.
  - **Mark the migration complete** needs zero differences and every record imported. Otherwise
    an owner or admin accepts the differences with a note. The report as accepted is kept, and
    the migration becomes read-only.
- **Match attachments:** files not linked to a record are listed with suggestions (QuickBooks
  id, number, amount, date, name), search across transactions, **Attach** and **Set aside**.
  Attached files are in the document library with "From QuickBooks, attached there …".
- **Sensitive fields:** tax ids, SSNs, birth dates, pay details, and bank and card numbers are
  never imported. The agent doesn't send them, and the server drops them before storing
  anything.
- **Seed:** a second company, **Sunrise Landscaping (from QuickBooks)**, is imported from the
  development QuickBooks Online company through connect → pull → import → complete. One
  attachment waits on Match attachments.

## Configuration

| Variable                             | Default                                      | Notes                                                                                                                                   |
| ------------------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `QBO_ENVIRONMENT`                    | `mock`                                       | `sandbox` or `production` call Intuit; `mock` serves a demo company (development and tests; refused in production); `none` turns it off |
| `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` |                                              | From the Intuit Developer app; required with `sandbox`/`production`                                                                     |
| `QBO_REDIRECT_URI`                   | `WEB_ORIGIN` + `/api/migration/qbo/callback` | Must be registered on the Intuit app                                                                                                    |
| `QBO_MINOR_VERSION`                  | `75`                                         | Intuit API minor version                                                                                                                |
| `MIGRATION_AGENT_KEY_DAYS`           | `7`                                          | How long a Desktop agent pairing key is valid (1–30)                                                                                    |

The Desktop agent is built by CI (`agent-windows` job, artifact `QbMigrationAgent`). See
`apps/desktop-agent/README.md` to build and run it.

## Demo script

1. Run `pnpm db:migrate && pnpm db:seed && pnpm dev` and sign in as `demo@example.com`.
2. Switch to **Sunrise Landscaping (from QuickBooks)** and press `g i`. Open the completed
   migration:
   - the records and their warnings;
   - the Migration Report: every year end ties out.
3. Open **Invoices**: invoice 1037 has its discount and sales tax. In **Expenses**, check 1002 to
   Metro Fuel has its receipt attached.
4. Back in `g i`, **Match attachments (1)**: the signed Oak Hills invoice is suggested for
   invoice 1050. Attach it.
5. Create a new company and press `g i`:
   - **Start with QuickBooks Online** → **Connect** (the development connector comes straight
     back) → **Pull from QuickBooks** → **Run the import**.
   - The report ties out. Drill into **Utilities**.
6. In another new company, **Start with CSV and Excel exports**:
   - Choose "Customers" and upload `apps/api/test/fixtures/quickbooks/csv/customers.csv`. The
     columns are mapped from the headers; **Preview**, then **Add 2 records** and run the
     import.
   - Add `trial-balance.csv` to see the report compare against it.
7. **Desktop** (on Windows with QuickBooks Desktop): **Start with QuickBooks Desktop** →
   **Create a pairing key**, run `QbMigrationAgent.exe`, enter the address and key, and upload.
   Then run the import here.

Screenshots from the end-to-end run: `docs/screenshots/60-import-hub.png` to
`64-csv-mapping.png`.

## Tests

| Suite                   | Count | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`       | 114   | +4: CSV column guessing from headers (case and punctuation), one column per field, required fields per kind, canonical schemas take exact decimals and ISO dates only                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/crypto`       | 13    | Unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/db`           | 58    | +6: tenant isolation of every migration table, unique staging keys, no deletes on the map by the app role, agent key lookup without a tenant context, discard cascade, completion check                                                                                                                                                                                                                                                                                                                                                 |
| `apps/api`              | 226   | +36. Units: amounts and dates as QuickBooks writes them, account types, Windows-1252, IIF parsing, GL classification, GL detail grouping, Intuit paging/refresh/throttling/reports, QBO mapping (bundles, discounts, tax, card credits), Desktop Journal report, opening entry, sensitive fields dropped. Integration: IIF, QBO (connect, pull, import, attachments, delta sync with an update and a delete), Desktop agent (pairing, batches, resume, attachments, discounts, paychecks), CSV, completion rules; each ties out to zero |
| `apps/desktop-agent`    | 12    | New: qbXML requests and iterators, response parsing, JSON conversion, sensitive elements never uploaded, checkpoints and resume, Attach folder, runner against a fake QuickBooks and API                                                                                                                                                                                                                                                                                                                                                |
| `apps/web` (Playwright) | 8     | +1: connect and pull QuickBooks Online, import, report ties out, drill-down, match an attachment, complete, open an imported invoice; CSV mapping, preview, import                                                                                                                                                                                                                                                                                                                                                                      |

## Known gaps and decisions for later phases

- **Real samples:** the importers are tested against synthetic data:
  - a mock of Intuit's API;
  - a generated Desktop export;
  - IIF and CSV fixtures.

  The QuickBooks Online sandbox, Desktop samples and Attach folder mentioned for this phase have
  not been provided yet. Once they are, they become regression fixtures (open question 31).

- **Not imported yet:**
  - inventory quantities and costs (Phase 10; inventory items arrive as non-inventory, with cost
    of goods sold kept per transaction);
  - sales tax agencies and rates (Phase 7);
  - budgets (Phase 7);
  - employees, payroll items and year-to-date wages (Phase 8; paychecks arrive as journal
    entries);
  - time activities (Phase 10);
  - memorized transactions, price levels and custom fields;
  - vendor TINs (open question 35).
- **Multiple A/R or A/P accounts:** the ledger has one of each, so documents on a second one
  come in as journal entries.
- **Locations** are imported as a list but not yet set on documents.
- **Background runs** are in-process, like email-in reading. A queue arrives with Phase 12.
- **The Desktop agent** is unsigned and has no installer yet (open question 33).
