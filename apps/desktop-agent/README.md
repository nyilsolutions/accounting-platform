# QuickBooks Desktop migration agent

A small Windows app that reads a QuickBooks Desktop company file through Intuit's QuickBooks SDK
(qbXML) and uploads it to a migration in the app. It never opens or parses the `.QBW` file
itself (ADR 0013).

## For the person migrating

1. In the app, go to **Company › Migration**. Choose **New migration › QuickBooks Desktop**, then
   **Create a pairing key**. The key is shown once and works for 7 days.
2. On the PC where QuickBooks Desktop is installed:
   - open the company file as the admin user, in single-user mode;
   - run `QbMigrationAgent.exe`.
3. Enter the server address and the pairing key, then choose **Connect to QuickBooks**.
   QuickBooks asks whether to allow the agent to read the company file. Choose **Yes, whenever
   this QuickBooks company file is open**.
4. Choose what to bring:
   - **All years** (recommended), or a starting year. With a starting year, earlier balances
     arrive as one opening entry.
   - The **Attach folder**. The agent suggests the one next to the company file.
5. Choose **Start upload**. If the upload stops (network, sleep, **Stop**), choose **Start upload**
   again: it resumes, and nothing is sent twice.
6. Back in the app, choose **Run import**, then check the **Migration Report**.

To migrate a `.QBB` backup or a `.QBM` portable file, restore it in QuickBooks Desktop first.

## What it sends

- Every list and transaction type in `Queries.All`: accounts, classes, terms, payment methods,
  customers and jobs, vendors, employees, other names, all item types, estimates, invoices,
  sales receipts, credit memos, payments, deposits, purchase orders, bills, vendor credits,
  checks, credit card charges and credits, bill payments, transfers and journal entries.
  Inactive list entries are included.
- QuickBooks' own trial balance at each fiscal year end and today, the A/R and A/P aging
  summaries, and the **Journal** report (every transaction's GL lines, by TxnID). The Journal lets
  the server:
  - bring in transaction types without a query here (paychecks, inventory adjustments, sales tax
    payments, item receipts, statement charges…) as journal entries;
  - true up lines QuickBooks posts that a document here doesn't (inventory cost of goods sold).
- The Attach folder's files, by their path. A QuickBooks id in the path links a file exactly;
  otherwise the server matches by number, amount, date and name, and the rest wait on the
  **Match attachments** screen.

The agent converts each qbXML `*Ret` element to JSON and does no mapping. The mapping lives in the
server (`apps/api/src/migration/sources/desktop`), so fixing a mapping never needs a new agent.

## Not yet brought over

What the SDK exposes but the app doesn't have yet:

- memorized transactions;
- price levels;
- custom fields (data extensions);
- payroll items and year-to-date by employee (Phase 8).

Paychecks' GL effect comes through the Journal.

## Develop

```bash
dotnet test apps/desktop-agent/QbMigrationAgent.sln        # core logic and tests (any OS)
dotnet publish apps/desktop-agent/src/QbMigrationAgent.Windows -c Release -p:PublishSingleFile=true -o out
```

- `QbMigrationAgent.Core` (net8.0) holds everything testable:
  - the qbXML requests;
  - the XML→JSON conversion;
  - the resumable runner and checkpoint;
  - the API client (retries with backoff).
- `QbMigrationAgent.Windows` (net8.0-windows, x86) is the WinForms wizard and the COM session.
  The QuickBooks SDK request processor (`QBXMLRP2`) is a 32-bit COM server, so the app is x86.
  It is late-bound, so no SDK reference is needed to build.
- CI:
  - tests the core on Linux;
  - builds and publishes the Windows app on Windows;
  - uploads the unsigned `.exe` as a build artifact.

## Before shipping to customers

- **Code signing:** sign `QbMigrationAgent.exe` (and an installer) with the company's
  code-signing certificate. Unsigned apps trigger SmartScreen warnings.
- **Installer:** an MSI (for example WiX) that installs per user, with no admin rights.
- **QuickBooks versions:** verify against the QuickBooks Desktop editions in use. The requests use
  qbXML 13.0 (QuickBooks 2014 and later). A query an older version refuses is skipped and
  recorded; its GL still arrives through the Journal.

These are listed in `docs/open-questions.md`.
