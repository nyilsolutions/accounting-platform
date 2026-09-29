# ADR 0012: Documents, receipt capture and email-in (Phase 5)

- Status: Accepted
- Date: 2026-09-29

## Context

Phase 5 of the master plan covers:

- attaching files to any record;
- a document library with folders, tags, search and bulk download;
- mobile camera capture;
- email-in per company;
- OCR/AI receipt capture that proposes an expense or bill and learns from corrections;
- versioning, virus scanning, encryption at rest, short-lived download links and retention.

Files are the most sensitive and the most hostile input the product accepts.

## Decision

### Documents, versions and links

- A **document** is a named record: folder, tags, note, source (upload, camera, email), inbox
  status and soft-delete state.
- **Versions** are separate rows. Each has its own storage key and is written once; a new upload
  is a new version, never an overwrite.
- A **link** attaches a document to a record: transaction, customer, vendor, item, account,
  reconciliation, estimate or purchase order. The link table is polymorphic, so the API checks
  that the record exists in the company. One document can support several records.
- Payroll entities (employee, pay run, tax filing) are added to the link types when they exist.

### File types come from the bytes

The type is detected from magic numbers, never the name or the browser's content type.

| Accepted                                                                                        | Refused                                                                                          |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| PDF, JPEG, PNG, GIF, WebP, HEIC, Office Open XML and 97–2003 Office files, CSV, UTF-8 text, ZIP | Everything else, including executables and HTML/SVG/XML (they could run script if ever rendered) |

- Only PDFs and JPEG/PNG/GIF/WebP images are shown inline. Everything else downloads with
  `Content-Disposition: attachment`.
- Every file response sends `X-Content-Type-Options: nosniff`, `Cache-Control: private,
no-store` and a restrictive CSP (sandboxed except for PDFs, which need the browser's viewer).
- HEIC photos are stored but not converted: that needs libheif/HEVC, which has patent-licensing
  questions (see open questions).

### Virus scanning before availability

- Every upload is scanned before it is stored:
  - **Infected**: the file is refused, never stored, and the attempt is audited.
  - **Scanner error**: the file is stored as "not scanned" and can't be downloaded, previewed,
    read or zipped until "Scan again" succeeds.
- `VirusScanner` implementations:
  - **ClamAV** over clamd's `INSTREAM` protocol (required in production);
  - a **dev** scanner that flags only the EICAR test file;
  - **none**, refused in production.
- Scans run inside the upload request. Uploads are capped at `MAX_UPLOAD_MB` (default 25).

### Storage and encryption at rest

`ObjectStore` has two implementations:

- **Local** (development, tests):
  - Each file is encrypted with AES-256-GCM under a random data key.
  - The data key is wrapped with `FieldEncryptor`, with AAD `document_version:<id>`, and stored
    on the version row.
  - A file on disk is useless without the database and the master key, and a key can't be moved
    to another version.
  - Files are written with `O_EXCL` (never overwritten) and mode 600.
- **S3** or any S3-compatible store (MinIO, R2):
  - Server-side encryption (SSE-S3 or SSE-KMS).
  - `If-None-Match: *` so objects are never overwritten.
  - Requests are signed by a small in-house SigV4 implementation, tested against AWS's published
    signing examples, instead of the AWS SDK.
- Production requires S3 (see configuration).

### Downloads: permission check, then a short-lived link

`GET …/documents/:id/url` checks `documents.view`, audits the download and returns a link that
expires in **5 minutes**:

- **S3**: a pre-signed S3 URL, with the file name and type set through
  `response-content-disposition` and `response-content-type`.
- **Local**: `/api/files/<token>/<name>`.
  - The token is HMAC-SHA256 over the company, the version, the disposition and the expiry.
  - The HMAC key is derived from the field-encryption key with HKDF, so no new secret is needed.
  - The trailing name is only a label for the browser's viewer.
  - The route is public: the token is the credential, and it is bound to one version.
- Next.js allows same-origin framing for `/api/files/*` only (for previews); every other route
  stays `X-Frame-Options: DENY`.

### Search

- Text is extracted at upload from PDFs with a text layer (unpdf), Word, Excel and PowerPoint
  (only the text parts are inflated, as a ZIP-bomb guard), CSV and plain text.
- A `tsvector` combines, by weight:
  - **A**: name and tags;
  - **B**: note, email sender and subject, and the vendor and invoice number read from a receipt;
  - **C**: the file's text.
- The query uses both the `english` configuration (stemming) and `simple` (exact names), plus a
  name substring match.
- Scanned images have no text layer; the receipt reading adds their vendor and number.

### Receipt and bill capture

- A `ReceiptExtractor` returns the document type, vendor, dates, invoice number, currency,
  subtotal, tax, total, payment method and lines.
- **Claude** (`DOCUMENT_AI=anthropic`) reads photos and PDFs:
  - one Messages API call with the image or PDF;
  - structured output (a Zod schema, parsed by the SDK), `effort: low` and model
    `DOCUMENT_AI_MODEL` (default `claude-opus-5-5`);
  - the server-side refusal fallback is enabled.
- **Heuristics** (`heuristic`, the development default) read text-layer PDFs and text: labelled
  totals, tax, dates, "Invoice No." and due dates.
- Whatever the source, values are normalized: amounts become decimal strings (never floats) and
  dates become ISO strings.
- The **draft**:
  - A bill when the document is an invoice; otherwise an expense.
  - The vendor comes from a learned alias first, then name matching.
  - The category comes from the alias, then the vendor's default.
  - It uses one line for the total, or the itemized lines when they (plus tax) add up to it.
- The person reviews the draft in the normal expense/check/bill form, next to the document.
  Creating it:
  - posts through `PurchaseDocumentsService` (and so `PostingService`);
  - attaches the document to the new transaction;
  - takes it out of the inbox;
  - **learns**: the normalized vendor name read from the receipt (for example `HOME DEPOT`) maps
    to the vendor and first category the person chose.
- Heuristic readings run inside the upload request. Claude readings run in the background, and
  the inbox polls for them.

### Email-in

- Each company has an address `<token>@INBOUND_EMAIL_DOMAIN`:
  - The token is 20 random base-36 characters.
  - It can be regenerated, which stops the old address.
  - It can be switched off.
- The mail provider posts each message as raw MIME to `POST /inbound/email`, signed with
  HMAC-SHA256 (`INBOUND_EMAIL_SECRET`) in `x-inbound-signature`. The route is exempt from the
  CSRF header check and authenticated by that signature.
- The recipient is looked up through a `security definer` function that returns only the owning
  company, as for Plaid webhooks. Unknown or disabled addresses are accepted and dropped, so a
  sender learns nothing.
- What is kept from a message:
  - each attachment (up to 20), except small inline images such as logos;
  - or, if there are none, the message text.
- Each item becomes an inbox document (source `email`, with sender and subject) and is read in
  the background. Files that aren't accepted are skipped; the rest of the message is kept.

### Retention and deletion

- Deleting is a soft delete, **owners and admins only**, and is audited. The document is hidden
  from everyone else but kept, with its bytes, for the company's retention period: default 7
  years, minimum 4 (employment tax records).
- **Restore** is available until then.
- **Purge** removes the bytes of deleted documents past retention. Metadata, hashes and the audit
  trail stay. Admins can run it now; a scheduled job comes with Phase 12.
- `acct_app` has no `DELETE` on documents or versions.

## Consequences

- Each file is used the same way everywhere: scanned, encrypted, versioned, linked and
  searchable.
- Expenses and bills created from receipts are ordinary transactions. They appear in reports,
  1099 tracking and bank-feed matching (a receipt entered first is matched when the bank
  transaction arrives).
- Sending receipts to Anthropic is a data-processing decision for the product owner (see open
  questions). It is off unless `DOCUMENT_AI=anthropic`.
- There is no in-app OCR for scanned PDFs without AI reading: the text heuristics need a text
  layer.
