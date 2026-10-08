# Phase 4: Banking

## Delivered

- **Banking page:**
  - One card per bank and credit card account, with the bank's balance next to the balance in the
    books, the number waiting for review, and the connection status.
  - "Link account", "Update", "Manage connections" and "Upload transactions".
- **For Review, Categorized, Excluded** (ADR 0011):
  - Each bank transaction comes with a suggestion: a match to a transaction already entered, a
    bank rule, the category used last time for the same payee, or a vendor named in the
    description.
  - **Add** creates an expense, a check (when the bank reports a check number), a deposit or a
    credit card credit. It can be split across categories and customers.
  - **Match** links a transaction already entered, with "find other records".
  - **Record as transfer**.
  - **Exclude**, **restore**, **undo**.
  - **Batch accept**, exclude, restore and undo. Items that can't be accepted are skipped with the
    reason.
  - Accepted transactions are marked cleared, so reconciliation starts pre-ticked.
  - Voiding or deleting a transaction sends its bank transaction back to For Review.
- **Upload transactions:**
  - Web Connect (.qbo), Quicken (.qfx) and OFX 1.x/2.x files, including files with several
    accounts.
  - CSV with column mapping, date-format detection, signed or money-out/money-in amounts, and flip
    signs for card exports. The mapping is remembered per account.
  - A preview before importing, and an optional "skip transactions before".
  - Duplicates are skipped: by bank id, and across sources (a file after the live feed).
- **Bank rules:**
  - Description, payee or amount conditions (all or any); money in, out or both; chosen accounts.
  - Categorize (with payee and memo), transfer or exclude.
  - Priority order, and **auto-add**.
- **Live bank feeds:**
  - A `BankDataProvider` interface with a Plaid implementation: Link, token exchange, accounts,
    Transactions Sync, signed webhooks, and re-authentication in Link update mode.
  - A development bank (mock) for demos and tests.
  - Map each downloaded account to a bank or credit card account and choose the start date.
  - Access tokens are encrypted and never shown or audited.
- **Registers:**
  - A running balance for bank, card and other balance sheet accounts, with Payment/Deposit
    (Payment/Charge for cards) columns.
  - The payee and other account ("-Split-"), a cleared column you can tick (C) with reconciled
    shown as R, and a "Bank" badge on items from the feed.
  - Search, a date range and paging.
- **Transfers** between balance sheet accounts, including **paying a credit card**. Edit, void
  and delete.
- **Reconcile:**
  - Statement date and ending balance, and payments and deposits to tick (tick all per section).
  - Beginning, cleared, ending and difference.
  - Finish only at 0.00, save for later, or cancel.
  - History with **reconciliation reports** (printable) and **undo last reconciliation**.
  - The amounts of reconciled transactions are protected until the reconciliation is undone.
- **Dashboard:** a Bank accounts card, and the set-up checklist links to Banking.
- **Shortcuts:**

  | Keys  | Opens                            |
  | ----- | -------------------------------- |
  | `g b` | Banking                          |
  | `g f` | Transfer (or pay a credit card)  |
  | `g z` | Reconcile                        |
  | `g k` | Bank deposit (existing since P2) |

  Bank rules and Upload bank transactions are in the `Ctrl/⌘+K` palette.

- **Permissions:** `banking.view` to read and `banking.manage` to change. Registers are also
  readable with `ledger.view`, and reconciliation reports with `reports.view`.
- **Seed:** the demo company has:
  - a credit card payment (transfer);
  - two bank rules (Fuel, and Bank fees with auto-add);
  - an uploaded May statement for Checking: one item matches the card payment, one matches check
    1001, the service fee was auto-added, and the rest wait for review.

## Configuration

| Variable             | Values                            | Notes                                                             |
| -------------------- | --------------------------------- | ----------------------------------------------------------------- |
| `BANK_FEED_PROVIDER` | `mock` (default), `plaid`, `none` | `mock` is refused in production; `none` means file imports only   |
| `PLAID_CLIENT_ID`    |                                   | Required with `plaid`                                             |
| `PLAID_SECRET`       |                                   | Required with `plaid`; never logged                               |
| `PLAID_ENV`          | `sandbox` (default), `production` |                                                                   |
| `PLAID_WEBHOOK_URL`  | `https://…/api/webhooks/plaid`    | Optional; without it, downloads happen on "Update" and after Link |

## Demo script

1. Run `pnpm db:migrate && pnpm db:seed && pnpm dev` and sign in as `demo@example.com`.
2. Press `g b`. On Checking:
   - "ONLINE TRANSFER TO CARD" suggests the card payment; press **Match**.
   - "CHECK 1001" suggests the check paid in the Phase 3 demo; press **Match**.
3. The SHELL row shows "Rule: Fuel". Tick it and **Accept 1**.
4. Press **Review** on HOME DEPOT and split it between Repairs and Maintenance and Supplies.
5. Open **Categorized**: the service fee was added by the Bank fees rule. Undo it, and it's back
   in For Review.
6. Press **Link account**, then **Connect First Mock Bank**. Map Business Checking to Savings and
   Business Visa to Credit Card. Seven Savings transactions arrive.
7. Press `g z` and choose Checking. Enter the statement date and the cleared balance shown; the
   matched items arrive ticked. **Finish now** opens the reconciliation report.
8. Open the SHELL expense and try to change its amount: it's reconciled. Go back to **Reconcile ›
   History**, undo the reconciliation, and the change goes through.

## Tests

| Suite                   | Count | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`       | 94    | +47: OFX SGML/XML (bank and card, missing FITIDs, entities, dates), CSV (quoting, separators, BOM, date formats, signed and split amounts, flip signs, repeatable ids), bank amount formats with **property tests** (exact round trips), description similarity, rule matching (text, amount, direction, accounts, all/any, priority), banking schemas, `formatDollars`                                                                                                                                                                                                                                     |
| `packages/crypto`       | 13    | Unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/db`           | 45    | +9: transfer type, bank-id duplicates, zero amounts and status rules, tenant isolation and cross-company references, one reconciliation in progress, reconciled needs a reconciliation, rule actions need accounts, one feed per account, webhook tenant lookup (and the table stays hidden)                                                                                                                                                                                                                                                                                                                |
| `apps/api`              | 140   | +35: transfers and registers (natural signs), OFX import and re-import, match/add/split/deposit/transfer, rules with auto-add and CSV mapping, exclude/restore/batch/undo, learned categories, card payment matched with the card's sign, reconciliation (pre-ticked, zero difference, finish, report, undo), reconciled amounts protected, void returns the bank transaction to For Review, audit, mock connection (map, sync, balances, disconnect), access tokens never exposed, webhooks, body limits; matching and duplicate scoring; Plaid provider with a fake API and real ES256 webhook signatures |
| `apps/web` (Playwright) | 6     | +1: transfer (card payment) → upload QBO → match, categorize, split deposit → bank rule and batch accept → register → reconcile with untick/retick → report → link mock bank and map accounts → dashboard                                                                                                                                                                                                                                                                                                                                                                                                   |

## Known gaps and decisions for later phases

- **Plaid in production** needs a Plaid account, production access and a public webhook URL
  (see open questions). Everything is tested against a fake Plaid API and the mock bank.
- There is no **scheduled sync**. Downloads happen on "Update", after connecting, and on Plaid
  webhooks. A nightly job comes with background jobs (Phase 12).
- **Matching to open invoices or bills** (receive payment or pay a bill straight from the bank
  feed) isn't offered yet. Enter the payment, then match it.
- **Service charges and interest** aren't entered on the reconcile screen; add them from the
  bank feed or as an expense or deposit first.
- **Reconciled transactions can't change amount** until the reconciliation is undone (QuickBooks
  warns instead; see open questions).
- A **vendor refund** can't name the vendor on a deposit.
- **Multi-currency** bank accounts come with Phase 10.
