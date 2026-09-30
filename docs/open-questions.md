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
4. **Which states** should payroll support first (Phase 8)? _Answered: Illinois, Texas, Florida,
   California and New York (see `docs/states.md`)._
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

## QuickBooks migration (Phase 6)

31. **Real samples for regression fixtures:** the importers are tested against synthetic
    companies:
    - a QuickBooks Online demo company answered by a mock of Intuit's API;
    - a Desktop agent export;
    - IIF and CSV files.

    Please provide:
    - QBO sandbox credentials (Intuit Developer account);
    - a Desktop company exported with the agent;
    - IIF and CSV exports;
    - an Attach folder.

    With those we will tie the Migration Report out to zero on each and add the scrubbed samples
    as fixtures. The Desktop report parsing (trial balance, agings, Journal) in particular needs
    checking against real qbXML output.

32. **Intuit app and production keys:** production QBO access needs an Intuit Developer app, its
    redirect URI (`…/api/migration/qbo/callback`) and Intuit's app assessment. Who owns the Intuit
    account?
33. **Desktop agent distribution:**
    - Which code-signing certificate (EV or OV)?
    - Should the agent ship as an MSI installer or a signed single `.exe`?
    - Which QuickBooks Desktop editions and years must it support? It uses qbXML 13.0,
      QuickBooks 2014 and later.
34. **What isn't brought over yet:**
    - inventory quantities and average cost (Phase 10; inventory items arrive as non-inventory,
      and their cost of goods sold is kept per transaction);
    - sales tax agencies and rates (Phase 7 added sales tax, but imported tax still goes to the
      sales tax liability account without an agency; see question 41);
    - payroll items and year-to-date by employee (Phase 8; paychecks arrive as journal entries);
    - budgets (Phase 7 added budgets, but QuickBooks budgets aren't imported yet), time
      activities (Phase 10), memorized transactions, price levels and custom fields.

    Which of these must be in place before your first client migrates?

35. **Vendor TINs:** tax ids are not imported. Social Security numbers, birth dates, pay details,
    and bank and card numbers aren't either. The agent never uploads them, and the server drops
    them before anything is stored. Clients re-enter vendor TINs, which 1099s need. Should the
    import instead carry TINs across, encrypted like the ones entered here?
36. **Accepting differences:** today owners and admins can complete a migration with differences
    if they write a note. Should an external accountant's sign-off be required instead, or as
    well?
37. **Duplicate numbers:** invoice and sales receipt numbers must be unique here. A QuickBooks
    duplicate is imported with a suffix (`1001-2`) and a warning. Is that acceptable, or should
    duplicates be allowed for imported history?

## Reports, sales tax and budgets (Phase 7)

38. **Where your clients file sales tax:**
    - Which states and local jurisdictions?
    - Do any file on a cash basis (tax owed when collected)? Today the liability is accrual:
      owed when charged.
    - Should rates be looked up by ship-to address through an external service (Avalara, TaxJar
      or another)? If so, which one? The calculator interface is ready for it.
39. **Rounding:** tax is rounded per component (state, county, city), as QuickBooks does. A few
    states compute on the combined rate and split the result. Do any of your clients' states
    require that?
40. **Scheduled report recipients:** anyone who can see reports can email them to any address
    (at most 20, audited). Should recipients be limited to people in the company, or to
    approved domains?
41. **Sales tax from QuickBooks:** imported invoices carry their tax as an amount without an
    agency. It shows as "not assigned" on the liability report, and the report still ties.
    Should the import map QuickBooks tax codes and agencies to rates here (a Phase 6 follow-up)?
42. **Budgets:**
    - Are budgets for balance sheet accounts needed?
    - Budgets by class and customer at the same time?
    - Budgets longer than twelve months?
43. **Branded report PDFs:** exports use a plain layout with the company name. Should PDFs carry
    the company logo (the same question as item 14 for invoices)?

## Payroll setup (Phase 8)

44. **Payroll tax data:** `tax-data/2026/federal.json` and `states/{il,ny,ca,fl,tx}.json` are
    approved by you for building (2026-09-30) and wait for a CPA or payroll specialist's review
    (`reviewedBy`) before real paychecks. The tax engine refuses anything not sourced, with the
    reason. Still needed:
    - **New York**: Disability Benefits employee limit (DBL withholding is optional, so paychecks
      don't wait on it); Publication 420 (MCTMT rates); which table applies to IT-2104 "Married,
      but withhold at higher single rate" (expected: single); how employee pre-tax deductions
      (401(k), cafeteria plan, FSA, HSA), tips and company contributions count for unemployment
      and for Paid Family Leave. Paid Family Leave itself is now calculated (0.432%, $411.91 cap);
    - **California**: the 2026 California Employer's Guide (DE 44) for income tax withholding
      (every California paycheck waits on this). One conflict for the reviewer: DE 231EB (2017)
      shows employer 401(k) contributions as subject to unemployment and SDI, the newer DE 231A
      (2023) says they are not; payroll follows DE 231A;
    - **Florida**: whether employee 401(k) deferrals are reemployment tax wages. Section
      443.1217(2)(f)1 exempts payments "to a trust described in s. 401(a)" without the
      salary-reduction exception it makes for 403(b), and the Employer Guide (RT-800002) doesn't
      mention 401(k). Florida paychecks with a 401(k) deduction wait on this; also company HSA
      contributions and reimbursements;
    - **Illinois**: how 403(b), HSA and reimbursements count for unemployment. A health FSA is
      treated as excluded (a cafeteria-plan benefit for medical expenses); a reviewer should
      confirm;
    - **Texas**: company-paid health insurance outside a cafeteria plan, tips, reimbursements and
      taxable fringe benefits for unemployment; the new-employer rate;
    - **Roth 401(k)/403(b)**: a citation that designated Roth contributions are wages (Form W-2
      instructions or Pub. 525);
    - the **2026 FUTA credit reduction states** (Department of Labor, November 2026). Paychecks
      use the 0.6% net rate; a credit reduction is added on Form 940 at year end.

    A paycheck with a kind of pay whose treatment isn't sourced for its state is refused with the
    reason; everything else is calculated.

45. **Your direct deposit bank (ODFI):** which bank will originate the ACH files? Banks differ on:
    - a balanced file (an offsetting debit to your account) or credits only (built today);
    - line endings (CRLF today) and the immediate origin and company ID they assign;
    - whether prenotes are required, and how many business days to wait after one.
46. **Pay dates on bank holidays:** a pay date on a weekend moves to the Friday before. Should
    Federal Reserve holidays move it too? If so, the holiday list would live in `tax-data`.
47. **State certificate fields:** the IL-W-4, DE 4 and IT-2104 fields follow the forms as we know
    them. The state sites are blocked here, so the fields have not been checked against the
    current forms. Please confirm them, or allow the state hosts so we can.
48. **Paid sick leave:** California and New York require minimum paid sick leave, and some cities
    have their own rules. Should PTO policies enforce those minimums, or is that the employer's
    job?
49. **Who can see full SSNs:** owners, admins, accountants and payroll admins can reveal an
    employee's SSN, and every reveal is audit-logged. Is that the right group?
50. **Missing Form W-4:** an employee without a W-4 is flagged. Pub 15-T says to withhold as
    single with no adjustments until one arrives. Should payroll allow paying them that way, or
    block the paycheck until a W-4 is on file?

## Pay runs (Phase 8, part 2)

51. **Pay before payroll starts here:** wage bases and caps (social security, FUTA, state
    unemployment, Paid Family Leave, 401(k) limits) use year-to-date wages from paychecks posted
    here. A company that starts mid-year needs its earlier 2026 pay entered. Should we add a
    "prior payroll" entry (year-to-date totals per employee as of the start date), or import it
    from QuickBooks (Phase 6 doesn't carry paychecks)?
52. **Garnishment limits:** a garnishment is taken as entered, up to its total owed. The Consumer
    Credit Protection Act caps most garnishments at a share of disposable earnings (and child
    support at 50–65%), and states have their own limits. Should payroll enforce them? If so, the
    limits belong in `tax-data` with citations.
53. **Working in more than one state, and Yonkers nonresidents:** each employee's taxes go to their
    work state. Employees who live in one state and work in another (reciprocity, resident-state
    withholding) or who split time between states are not handled, and the Yonkers nonresident
    earnings tax (implemented and tested) needs to know who works in Yonkers. How common is this
    for your customers?
54. **Paper paychecks:** paychecks paid by check are marked "to print" but can't be printed yet
    with the check printing from Phase 3 (voucher stubs differ). Do customers print paychecks, or
    is direct deposit plus a pay stub enough for now?
