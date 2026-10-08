# Open questions

Questions that need a decision from the product owner, a CPA/payroll specialist, or legal counsel.
Add new questions here instead of guessing.

## Product

1. **Product name.** "Accounting Platform" is a placeholder (`APP_NAME` / `NEXT_PUBLIC_APP_NAME`).
2. **Audience:** is this for your firm's own clients only, or a SaaS sold publicly? This affects
   SOC 2 timing, e-file provider applications and pricing/billing work.
3. **Registration:** open self-signup (current), or invite-only for your firm's clients?
   Self-signup currently reveals whether an email is registered (409 on duplicate); invite-only
   would remove that.
4. **Which states** should payroll support first (Phase 8)?
5. **Which QuickBooks editions** do your clients use (Online, Desktop Pro/Premier/Enterprise)? Sample
   files or a QBO sandbox are needed for Phase 6.

## Security and operations

6. **Email provider** for invitations and notifications (AWS SES, Postmark, SendGrid…).
7. **Cloud and KMS:** AWS, Azure or GCP? This decides the KMS provider for field encryption and the
   hosting design.
8. **Session policy:** are the defaults acceptable (60-minute idle, 12-hour absolute)? Accounting
   firms sometimes require shorter.
9. **Password reset with mandatory MFA:** allow self-service reset with email plus TOTP or a
   recovery code, and require admin/support identity verification when both are lost?

## Accounting (needed for Phase 1)

10. **Default chart of accounts** per tax form or industry. Do you have preferred templates?
11. **Account numbering:** on or off by default?

## Sales and receivables (Phase 2)

12. **Unapplied payments as credits.** Today an overpayment stays a credit on that payment, and
    only editing the payment applies it to a later invoice. QuickBooks also lets you pick it as a
    credit when receiving the next payment. Should we build that in Phase 3?
13. **Document numbers:** unique per type (invoice 1001 and sales receipt 1001 can coexist) and
    editable. QuickBooks Online can warn instead of blocking duplicates. Is blocking acceptable?
14. **Invoice PDFs and branding:** browser "Save as PDF" is used today. Do you need server-made
    PDF attachments on emails, logos and custom templates before launch?
15. **Customer-facing email:** which sender address and domain should invoices come from (this
    also affects the email provider question, item 6)?
16. **Cash-basis A/R:** on the cash Balance Sheet, an unapplied payment shows as a credit balance
    in A/R (QuickBooks behavior). Would your CPAs prefer it reclassified as a customer deposit
    liability?

## Purchases and payables (Phase 3)

17. **1099 thresholds for 2026** (`tax-data/2026/form-1099.json`): $2,000 for NEC and MISC boxes
    1, 3 and 6 under the One Big Beautiful Bill Act, and $10 for royalties. Please have a CPA
    confirm these and the citations, and set `reviewedBy`. Should box 10 (gross proceeds paid to an
    attorney) be tracked too?
18. **Early-payment discounts** on bills (such as "1% 10 Net 30"): should Pay Bills offer the
    discount automatically, and which account should it post to (Discounts Taken, or reducing the
    expense)?
19. **Check numbers:** should typing a number already used on a check be blocked (as printing
    does) or only warned?
20. **1099 and card payments:** we exclude anything paid by credit card (reported on 1099-K). Is
    that right for your clients, including debit cards and payment apps?

## Banking (Phase 4)

21. **Plaid account:** live bank feeds need a Plaid client id and secret, production access
    (Plaid reviews the use case) and a public HTTPS URL for webhooks. Who should own the Plaid
    account, and which plan? Until then `BANK_FEED_PROVIDER=none` (file imports) or the mock.
22. **Editing reconciled transactions:** we block changing the amount, voiding or deleting a
    reconciled transaction until the reconciliation is undone. QuickBooks only warns and lets the
    reconciliation go out of balance. Should an accountant role be allowed to override with a
    warning?
23. **Download history:** new connections download 90 days by default (editable per account). Is
    that right for your clients, or should it default to the start of the fiscal year?
24. **Who can undo a reconciliation:** today anyone with `banking.manage`. QuickBooks Online
    limits it to accountant users. Should it need the accountant or admin role?
25. **Bank feed transactions from closed periods:** they can be downloaded and reviewed, but
    adding them needs the closing-date password. Should they be excluded automatically instead?

## Documents (Phase 5)

26. **AI receipt reading and data processing:** reading receipts with Claude sends the file to
    Anthropic's API. Is that acceptable for your clients under your privacy policy and client
    agreements, and do you want a zero-data-retention arrangement first? Until decided,
    `DOCUMENT_AI=heuristic` reads only text-based PDFs.
27. **HEIC photos:** converting iPhone HEIC photos to JPEG needs an HEVC decoder (libheif), which
    has patent-licensing implications. Should we license a converter, convert in the browser
    before upload, or ask users to set their phones to JPEG?
28. **Retention:** is 7 years the right default for your clients (IRS guidance ranges from 3 to 7
    years; employment tax records at least 4)? Should some document types (payroll, 1099) have
    their own longer periods?
29. **Email-in senders:** today any sender who knows a company's address can add documents to its
    inbox (they are scanned and wait for review). Should we restrict senders to company users or
    an allow-list?
30. **Storage and malware scanning in production:** which S3 region, bucket policy and KMS key,
    and will ClamAV run as a sidecar or a managed scanning service?
