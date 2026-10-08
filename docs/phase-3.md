# Phase 3: Purchases and accounts payable

## Delivered

- **Purchase documents** (ADR 0010): bills, vendor credits, checks, expenses and credit card
  credits.
  - Each line is a category (any account except A/R and A/P) or a product. A product fills its
    purchase description and cost. Quantity × rate works as on sales forms.
  - Each line can name the **customer or job** it was for, and a class.
  - Bills have terms and due dates (from the vendor's terms by default) and the vendor's bill
    number.
  - Checks and expenses name the bank or card that paid. Checks have a mailing address and
    **print later**. The next check number is suggested per bank account.
  - A vendor's default expense account fills the first line.
  - Edit, void and delete (records are kept), all behind the closing-date password. A bill with
    payments can't be voided until the payment changes.
- **Pay bills:**
  - Pay bills across vendors at once, applying vendor credits.
  - Pay from a bank (as checks, numbered from a starting number or queued to print) or a credit
    card.
  - One bill payment is recorded per vendor.
  - A bill payment can be edited or voided later; voiding reopens its bills.
- **Check printing:**
  - The print queue lists checks and bill payments marked "print later".
  - Printing assigns consecutive numbers (refusing numbers already used) and prints voucher
    checks: amount in figures and words, payee address, memo, and two stubs listing the bills
    paid or the expense lines.
- **Purchase orders:** open or closed, expected date, ship-to, and **copy to bill**. A PO that has
  been billed is locked and links to its bill.
- **Vendors:**
  - The vendor list shows open balances.
  - Each vendor has a page with open balance, overdue amount, vendor credits, transactions and
    quick actions (new bill, pay bills, write check, new PO).
- **Expenses hub:**
  - A money bar (unpaid, overdue, unused credits) and every purchase transaction.
  - Filters by type and bill status (unpaid, overdue, paid), search, voided entries, paging, and a
    "to print" badge.
- **1099 tracking:**
  - Map expense accounts to 1099-NEC box 1 or 1099-MISC boxes 1, 2, 3 and 6.
  - A yearly contractor summary follows the money: bank payments only, bills as they are paid, and
    card payments excluded.
  - It shows the year's thresholds from `tax-data` (with citations), flags who needs a 1099, and
    flags missing TINs and addresses.
- **Reports:**
  - A/P Aging Summary and Detail, Unpaid Bills, Vendor Balance Summary.
  - Expenses by Vendor Summary, 1099 Contractor Summary.
  - Vendor filter and drill-down to vendors and transactions.
  - **Cash basis now covers bills and vendor credits.**
- **Dashboard:** a Bills card with unpaid and overdue totals.
- **Shortcuts:**

  | Keys  | Opens       |
  | ----- | ----------- |
  | `g m` | New bill    |
  | `g v` | Pay bills   |
  | `g x` | New expense |
  | `g w` | Write check |

  Print checks, New purchase order and Vendors are in the `Ctrl/⌘+K` palette.

- **Permissions:** `purchases.view` to read and `purchases.manage` to change, including check
  printing and 1099 mappings.
- **Seed:** the demo company has:
  - a paid bill (check 1001) and an unpaid bill;
  - a check to a 1099 contractor waiting to print;
  - a credit card expense;
  - an open purchase order;
  - Contract Labor mapped to 1099-NEC.

## Demo script

1. Run `pnpm db:migrate && pnpm db:seed && pnpm dev` and sign in as `demo@example.com`.
2. Press `g m`. Choose _Green Supply Co._, add a Cost of Goods Sold line of 10 × 30 for customer
   _Hillside HOA_, and save.
3. Press `g v`. Tick the new bill and the unpaid GS-2107, choose **Print later** and save.
4. Open **Expenses › Print checks**. The Rivera Tree Service check and the new payment are
   waiting. Print them from number 1002 and look at the amount in words and the stubs.
5. Open **Expenses › 1099 contractors**. Rivera Tree Service shows under NEC box 1, with its
   missing TIN flagged.
6. Open **Expenses › Purchase orders**, open the perennials PO and choose **Copy to bill**.
7. Press `g r`. Open **A/P Aging Summary** and click a vendor. Then open **Profit and Loss** and
   switch to **Cash**: unpaid bills drop out of expenses.

## Tests

| Suite                   | Count | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`       | 47    | +17: amount in words (known answers and a property test), purchase/bill-payment/pay-bills/PO/1099 schema rules                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/crypto`       | 13    | Unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/db`           | 36    | +7: zero-line credit-only bill payments, other purchase types still balanced, unknown types, cross-company vendor, PO privacy, PO line rules, 1099 mapping rules                                                                                                                                                                                                                                                                                                                                  |
| `apps/api`              | 105   | +21: bills with terms, items and job costing; vendor credits; partial and credit bill payments; zero payments; voids; checks, expenses and card credits; check numbering and printing (words, stubs, duplicate numbers); Pay Bills across vendors; PO copy to bill; 1099 mapping and yearly summary (thresholds from tax-data, card payments excluded); A/P reports and cash basis; **property test**: A/P aging = A/P balance, cash Balance Sheet balances, cash − accrual income = unpaid bills |
| `apps/web` (Playwright) | 5     | +1: vendors → bill → pay bills with print later → print checks → write check → 1099 mapping and summary → PO copy to bill → A/P aging drill-down → dashboard                                                                                                                                                                                                                                                                                                                                      |

## Known gaps and decisions for later phases

- **Early-payment discounts** (for example 1% 10 Net 30) aren't applied on bill payments yet. See
  open questions.
- Vendor **prepayments** are entered as a check or expense to the expense (or a prepaid) account.
  Bill payments can't have an unapplied amount.
- **Check numbers:** duplicates are refused when printing, but not when a number is typed on a
  check. Voided checks keep their number.
- **Billable expenses** (charging a job's costs to the customer's next invoice) come with
  time tracking (Phase 10). The customer on expense lines is recorded for job costing now.
- **Item receipts, partial PO receipts and inventory** are Phase 10.
- **1099 forms, e-file and TIN matching** are Phase 9. The 2026 thresholds in `tax-data` await
  CPA review.
- **PDFs and email:**
  - Purchase orders aren't emailed yet.
  - Checks and POs print through the browser.
- **Credit card payments** (paying the card balance) and transfers come with Banking (Phase 4).
