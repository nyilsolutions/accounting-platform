# ADR 0011: Banking: registers, reconciliation, bank feeds (Phase 4)

- Status: Accepted
- Date: 2026-09-29

## Context

Phase 4 adds what a bookkeeper does with bank and credit card accounts:

- registers and transfers;
- reconciliation against statements;
- statement file imports and live bank feeds, with a For Review workflow, matching and bank
  rules.

It has to keep the journal rules of ADR 0007 (one posting path, append-only versioned lines) and
the document design of ADR 0009/0010.

## Decision

### Transfers are journal transactions; everything else sits beside the journal

- A **transfer** is a new transaction type posted through `PostingService`: Dr "to", Cr "from".
  Paying a credit card is a transfer from the bank to the card.
- **Cleared and reconciled marks** live in `bank_clearings` (transaction × account), not on
  journal lines. Lines are versioned and append-only, but clearing is current state that changes
  often. A transaction can be cleared in one account and not in the other (a card payment clears
  the bank statement and the card statement separately).
- **Registers** are computed from the journal: each posted transaction's net on the account, a
  running balance ordered by date and entry, and the payee and "split" column from its other
  lines.

### Natural sign

Registers, reconciliations and downloaded transactions use the account's natural sign:

- For assets (bank), the balance goes up with debits.
- For liabilities (credit card, loans), the balance owed goes up with credits.

Bank amounts are signed as money into the account, which is debit − credit on the account for both
banks and cards. So a card payment (+) matches a transfer to the card, and a charge (−) matches an
expense paid by card.

### Reconciliation

| Step    | What happens                                                                                                                                                                                                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start   | Statement date and ending balance. One in progress per account (unique partial index). The date must be later than the last completed reconciliation.                                                                         |
| Tick    | Ticks are cleared marks, so they also show as "C" in the register. Transactions added or matched from the bank feed arrive ticked.                                                                                            |
| Balance | Beginning balance = everything reconciled so far. Cleared balance = beginning + ticked transactions dated on or before the statement date. Difference = ending − cleared.                                                     |
| Finish  | Only at a difference of 0.00. The ticked transactions become reconciled ("R") and point to the reconciliation.                                                                                                                |
| Undo    | Only the latest completed reconciliation of an account, and only with none in progress. Its transactions go back to cleared. Audited.                                                                                         |
| Report  | Summary (beginning, cleared, ending, uncleared, register balances) and detail. Payments and deposits (or charges and payments for a card) are listed as cleared, uncleared as of the statement, and after the statement date. |

**Reconciled amounts are protected.** `PostingService.revise` refuses a new version that changes a
reconciled transaction's net on the reconciled account, and `setStatus` refuses to void or delete
it (`409 RECONCILED`). Memo, payee, category and date changes are allowed. Undoing the
reconciliation is the way to change the amount. QuickBooks only warns here; see open questions.

### Bank transactions and For Review

- Downloaded and imported transactions land in `bank_feed_transactions` with a bank id, unique per
  account. The bank id is one of:
  - the FITID (`ofx:`);
  - Plaid's `transaction_id` (`plaid:`);
  - for files without ids, a content id (`csv:` or `ofx-h:`) of date, amount, a hash of the
    description, and an occurrence number (so two identical purchases on one day both import, and
    re-importing the file finds both as duplicates).
- **Duplicates from another source** (a file after the feed, or the reverse) are found by the same
  amount within 3 days and similar descriptions. Each existing row pairs with at most one new row,
  closest date first. Rows from the same source are compared by id only.
- **Suggestions** for each For Review item, first match wins:
  1. A match to a transaction already in the books: same amount; posted 5 days before to 10 days
     after it (90 days for a check with the same number); scored by date, check number and payee.
  2. The first bank rule that applies.
  3. The category chosen last time for the same payee (learned from earlier added items).
  4. A vendor or customer whose name appears in the description.
- **Accepting**:
  - Add creates a real document through its service: an expense (a check when the bank reports a
    check number), a deposit, or a credit card credit. Splits are supported.
  - Transfer creates a transfer.
  - Match links an existing transaction.
  - In every case the transaction is marked cleared in the account.
- **Exclude** hides an item; restore brings it back. **Undo**:
  - An added transaction is deleted.
  - A match is unlinked and its cleared mark removed.
- Voiding or deleting a transaction elsewhere sends its bank transaction back to For Review
  (`PostingService.setStatus`).
- **Batch** actions run each item in a savepoint. One failure (a closed period, a missing
  category) skips that item with a reason; the rest go through.

### Bank rules

- Conditions are on description, payee or amount (without its sign), combined with all or any.
- Rules can be limited to money in or out and to certain accounts.
- Actions: categorize (account, vendor or customer, class, memo), transfer, or exclude.
- Rules run in priority order (then name) and the first match wins. They are evaluated when the
  list is shown, so a new rule applies to items already waiting.
- **Auto-add** rules accept items as they arrive, except items that match a transaction already
  entered.

### File imports

- **OFX 1.x (SGML) and 2.x (XML).** One tolerant reader serves QFX and QuickBooks Web Connect
  (QBO) too. It reads leaf elements with or without closing tags. It supports:
  - bank (`STMTRS`) and credit card (`CCSTMTRS`) statements, and choosing among several in one
    file;
  - the ledger balance, stored as the account's last bank balance.
- **CSV** with RFC 4180 quoting and `,` `;` or tab separators:
  - column mapping: date, description, memo, payee, check number, and either a signed amount or
    money-out and money-in columns;
  - an option to flip signs;
  - date-format detection (MDY, DMY or YMD, with MDY preferred when ambiguous);
  - the mapping is saved per account.
- The parsers live in `@acct/shared`. The web parses the file to preview it and choose columns,
  and the API parses it again to import it. Files are sent as JSON text; only the import route
  accepts bodies over 256 KB (up to 6 MB).

### Live feeds: the `BankDataProvider` seam

- `BankDataProvider` defines:
  - `createLinkToken` (including update mode for re-authentication);
  - `exchangePublicToken`, `getAccounts`;
  - `syncTransactions(cursor)`;
  - `removeItem`;
  - `parseWebhook`, which verifies and reads a webhook.
- **Plaid** is implemented over its REST API without the SDK:
  - Link, `/item/public_token/exchange`, `/accounts/get`, `/transactions/sync` and
    `/item/remove`.
  - Pending transactions are skipped; the posted one arrives when it settles.
  - Plaid's sign (positive = money out) is flipped.
  - Webhooks are verified: ES256 JWT in `Plaid-Verification`, key from
    `/webhook_verification_key/get`, body SHA-256 and a 5-minute age limit.
- A **mock** provider serves development, tests and demos. It is refused in production.
- `BANK_FEED_PROVIDER=plaid|mock|none` chooses the provider. With `none`, banking works with file
  imports only.
- **Access tokens** are encrypted with `FieldEncryptor` (AAD `bank_connection:<id>:access_token`).
  They never appear in responses, logs or the audit log.
- **Sync** downloads every page first, with no database transaction open during network calls,
  then stores them in one transaction:
  - It ingests added transactions for mapped accounts from each account's start date (default 90
    days back).
  - It updates modified items still in For Review and deletes removed ones.
  - It stores balances and the cursor.
  - Mapping accounts resets the cursor so newly mapped accounts get their history; the bank ids
    make this safe.
- **Webhooks** arrive without a tenant context. `app_bank_connection_company(provider, item_id)`
  is a `security definer` function that returns only the owning company id. The API then works
  inside `withTenant` as the user who connected the bank.
  - `SYNC_UPDATES_AVAILABLE` triggers a sync.
  - Login errors mark the connection "sign-in needed" until the user re-authenticates through Link
    update mode.
- The webhook route is public and exempt from the CSRF header check. Authenticity comes from the
  signature, and it can only trigger a download or a status change for the item it names.

## Consequences

- Reconciliation and the bank feed read the same journal the reports read. Nothing in banking
  can make the books and the register disagree.
- Transactions created from the bank feed are ordinary expenses, checks, deposits, card credits
  and transfers. They appear in every report, the 1099 summary (bank-paid only) and cash basis
  without special cases.
- A Plaid account (client id, secret, production access and a public webhook URL) is needed
  before live feeds go beyond the mock; see open questions.
- Deposits can't name a vendor. A vendor refund arriving in the bank is categorized without a
  vendor, or matched to a deposit entered by hand.
