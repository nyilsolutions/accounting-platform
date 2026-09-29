# Phase 5: Documents

## Delivered

- **Document library** (`g o`):
  - Folders and subfolders, search across names, text, vendors, notes and tags, and type and tag
    filters.
  - Drag-and-drop multi-file upload, and **take a photo** on phones.
  - Preview PDFs and images in the page.
  - Rename, tags, notes, and moving documents between folders.
  - **Download several documents as a ZIP.**
  - Admins also see a **Deleted** view.
- **Attachments everywhere:** an attachments panel with drag-and-drop on every transaction
  (invoices, receipts, bills, expenses, checks, payments, deposits, bill payments, transfers,
  journal entries), on customers, vendors and reconciliation reports. One document can be
  attached to several records.
- **Versions:**
  - Upload a new version of a document; the earlier versions stay and can be downloaded.
  - Nothing is ever overwritten.
- **Safety:**
  - The file type is detected from the bytes.
  - Executables, HTML and SVG are refused.
  - Every upload is **virus scanned before it can be used**. ClamAV runs in production; infected
    files are refused and the attempt is audited.
  - Files are **encrypted at rest**: AES-256-GCM per file locally, SSE-S3/KMS on S3.
  - Files open through **5-minute links issued after the permission check**.
- **Receipts inbox** (`g q`):
  - Photograph, upload or email receipts and bills.
  - Each one is **read automatically**: vendor, date, invoice number, due date, tax, total and
    lines.
  - **Review** shows the document next to a proposed expense, check or bill. Creating it posts the
    transaction, attaches the document and learns the vendor and category for next time.
  - Reading uses Claude (`DOCUMENT_AI=anthropic`) for photos and PDFs, or text heuristics for
    text-based PDFs.
- **Email-in:**
  - Each company gets a private address (`<token>@<your inbound domain>`); forwarded receipts and
    bills land in the inbox.
  - The address can be changed or switched off.
  - Messages must be signed by the mail provider.
- **Retention:**
  - Company settings hold the retention period: default 7 years, at least 4.
  - Deleting is **owners and admins only**, is audited, and is a soft delete. Files stay until the
    retention period ends; then **purge** removes the bytes and keeps the record.
- **Search** reads inside PDFs (text layer), Word, Excel, PowerPoint, CSV and text files, plus
  vendors and invoice numbers read from receipts.
- **Seed:** the demo company has:
  - a lease in a Contracts folder;
  - a W-9 on Green Supply Co.;
  - a fuel receipt on the card expense;
  - two documents in the receipts inbox: a Home Depot receipt and a Green Supply invoice, both
    already read.

## Configuration

| Variable                                                             | Default      | Notes                                                                                               |
| -------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------- |
| `DOCUMENT_STORAGE`                                                   | `local`      | `s3` is required in production                                                                      |
| `DOCUMENT_STORAGE_DIR`                                               | `.documents` | Local encrypted files                                                                               |
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` |              | Required with `s3`                                                                                  |
| `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`                                 |              | MinIO, R2 and other S3-compatible stores                                                            |
| `S3_SSE`, `S3_KMS_KEY_ID`                                            | `AES256`     | `aws:kms` with a KMS key                                                                            |
| `MAX_UPLOAD_MB`                                                      | `25`         |                                                                                                     |
| `VIRUS_SCANNER`                                                      | `dev`        | `clamd` is required in production (`CLAMD_HOST`, `CLAMD_PORT`)                                      |
| `DOCUMENT_AI`                                                        | `heuristic`  | `anthropic` needs `ANTHROPIC_API_KEY`; `DOCUMENT_AI_MODEL` picks the model (default in `config.ts`) |
| `INBOUND_EMAIL_DOMAIN`, `INBOUND_EMAIL_SECRET`                       |              | Email-in; the provider posts raw MIME to `/api/inbound/email` with an HMAC signature                |

## Demo script

1. Run `pnpm db:migrate && pnpm db:seed && pnpm dev` and sign in as `demo@example.com`.
2. Press `g o`:
   - Open **Contracts** and preview the yard lease.
   - Search `rent`: the lease is found by the text inside the PDF.
3. Drop a few files on the page, tick two and choose **Download 2 as ZIP**.
4. Press `g q`. The Home Depot receipt and the Green Supply invoice have been read. **Review** the
   invoice: it proposes a **bill** with the invoice number and due date. Choose Green Supply Co.
   and a category, then **Create bill**.
5. Upload another Home Depot receipt to the inbox and review it: the vendor and category chosen
   before are filled in.
6. Open **Expenses**, then the new bill: the invoice is attached.
7. In **Company settings › Documents**, see the retention period and the email-in address (when
   `INBOUND_EMAIL_DOMAIN` is set).

## Tests

| Suite                   | Count | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`       | 110   | +16: file type detection (each accepted type, Office kinds, refused executables/HTML/SVG/invalid UTF-8, multi-byte edge), file name cleaning, tag and retention schemas, extraction schema (decimal strings, ISO dates)                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/crypto`       | 13    | Unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/db`           | 52    | +7: versions written once, no deletes by the app role, delete state rules, link types, tenant isolation, folder names, alias format, email-in lookup without a tenant context, unique inbox tokens                                                                                                                                                                                                                                                                                                                                                                                       |
| `apps/api`              | 190   | +50: SigV4 against AWS's published examples; encrypted local store (wrong AAD, tampering, overwrite, path tricks); S3 headers and pre-signed URLs; clamd INSTREAM against a fake daemon; text extraction; receipt heuristics, normalization and the Claude extractor against a fake API; signed tokens; upload/type/virus/size rules; downloads without a session; forged links; ZIP; versions; search; folders; attachments; receipt → expense with learning; bill drafts; email-in (signature, unknown and changed addresses, background reading); delete/restore/purge with retention |
| `apps/web` (Playwright) | 7     | +1: upload two files, refused file, preview and tags, full-text search, folders and move, ZIP download, receipts inbox upload and reading, review → create expense, attachment on the expense, settings                                                                                                                                                                                                                                                                                                                                                                                  |

## Known gaps and decisions for later phases

- **HEIC photos** are stored and scanned but not converted or previewed (see open questions).
  Phones can usually be set to send JPEG.
- **Scanned PDFs and photos** are read only with Claude (`DOCUMENT_AI=anthropic`); the heuristics
  need a text layer. There is no local OCR engine.
- **Purge** is manual (admins) until background jobs arrive (Phase 12). **Email-in** needs a mail
  provider's inbound webhook to be configured.
- **Payroll records** (employees, pay runs, tax filings) join the attachment targets with Phase 8.
- Files are scanned at upload only. **Re-scanning stored files** when virus signatures update is
  a Phase 12 job.
- **QuickBooks attachments** are downloaded into this library by the QuickBooks migration
  (Phase 6).
