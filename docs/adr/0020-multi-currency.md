# ADR 0020: Multi-currency (Phase 10c)

- Status: Accepted
- Date: 2026-09-30

## Context

Phase 10c lets a company bill customers and pay vendors in their own currency, as QuickBooks
multi-currency does.

The owner decided (2026-09-30):

- The home currency is **US dollars**. Multi-currency **can't be turned off** once it is on.
- Rates are **entered by hand**, with the **European Central Bank's daily feed** behind an
  interface.
- **Foreign-currency bank and credit card accounts** come in a follow-up part (10c-2). 10c covers
  foreign-currency customers and vendors: their documents, payments, rates and gains and losses.
  Money moves through US dollar accounts at the day's rate.
- **Unrealized gains and losses** are posted **on demand**: "Revalue currencies" (for example at
  month end) values open foreign balances at that date's rates. **Realized** gains and losses
  post automatically when payments settle.
- **Display:** invoices, bills, statements, open balances and payment screens are in the party's
  currency, with the US dollar value shown. Financial reports (P&L, balance sheet, aging totals)
  are in US dollars.

## Decision

### Currencies and rates

- `companies.multicurrency` is turned on by **Company settings › Currencies**. A trigger refuses
  turning it off. Turning it on creates **Exchange Gain or Loss** (Other Expense, system role
  `exchange_gain_loss`).
- A company adds currencies (`company_currencies`, never USD). Each currency gets its own
  **Accounts Receivable (EUR)** and **Accounts Payable (EUR)** accounts:
  - `accounts.currency` is set, with no system role;
  - there is one of each per currency;
  - the currency and type can't change afterwards (trigger).
- **Exchange rates:**
  - `exchange_rates` holds how many US dollars one unit is worth on a date: `numeric(19,10)`,
    greater than zero, one per currency and date.
  - Rates are exact decimals in code (`parseRate`, bigint 1/10¹⁰), never JS numbers.
  - A document uses the rate entered on it; otherwise the rate it already has (an edit);
    otherwise the latest rate on or before its date. With none, it asks for one.
- **European Central Bank:**
  - `ExchangeRateProvider`, with `EcbRateProvider`, reads `eurofxref-daily.xml` (the latest day)
    or `eurofxref-hist-90d.xml` (a date in the last 90 days).
  - It publishes units per euro, so US dollars per X = (USD per EUR) / (X per EUR), rounded to
    10 decimals (`crossRate`).
  - A rate entered by hand for the same date is never replaced by the feed.
  - Tests use a fake `fetch` serving fixtures, never the network (`EXCHANGE_RATE_PROVIDER=none`
    turns the feed off).

### Parties and documents

- **Customers and vendors** have a currency (null: US dollars). It can't change once they have
  transactions, estimates or purchase orders.
- **Documents:**
  - Invoices, sales receipts, credit memos, refund receipts, bills, vendor credits, checks,
    expenses and credit card credits are in the party's currency. `transactions.total` is in
    the currency, with `currency` and `exchange_rate` on the transaction.
  - Estimates and purchase orders record the currency.
- **Posting:**
  - Journal lines are always US dollars. Each line is converted on its own (`toHome`: rounded
    half away from zero to the cent). The control line is the sum of the converted lines, so
    the entry balances with no rounding line.
  - `home_total` keeps the document's US dollar value.
  - Invoices and credit memos post to A/R (currency), bills and vendor credits to A/P
    (currency); those lines also carry the amount in the currency (`foreign_debit`,
    `foreign_credit`).
  - Cash documents post to US dollar bank and card accounts at the rate.
- **Inventory** bought in a foreign currency comes in at the line's US dollar value.
- Once payments or credits are applied, a foreign-currency document's **total and rate can't
  change**: what was applied is valued at its rate.

### Payments and realized gains and losses

- A foreign-currency payment of A (in the currency) at rate r:
  - pays invoices I and uses credits C, leaving U = A + C − I unapplied;
  - deposits A × r in US dollars.
- **What each application relieves**, in US dollars at the document's own rate
  (`payment_applications.home_amount`):
  - its share of the document's `home_total` (`homeShare`);
  - or, when it settles the document, whatever US dollar value is left. So a document settled
    in its currency is settled in US dollars too, with no pennies left.
- **The entry:**
  - Dr deposit account A × r;
  - Dr A/R (currency) credits used at their rates;
  - Cr A/R (currency) invoices paid at their rates, plus U × r;
  - the difference to **Exchange Gain or Loss**.

  Bill payments mirror this: the difference between A/P relieved and the money paid.

- **Pay bills** uses the rate on file for the payment date. Checks print the US dollars paid;
  the voucher stub shows the vendor's currency.
- **Deposits** take a foreign payment or receipt at its US dollar value.
- **Cash basis** recognizes each application's `home_amount`, so a paid invoice's income comes
  in at its rate and the gain or loss on the payment makes up the money received.
  Revaluations aren't part of the cash basis.

### The subledger

- `openItems` keeps `amount` and `open` in US dollars:
  - documents: `home_total` less the `home_amount` applied;
  - payments: their control-account lines less their applications' `home_amount`.
- It adds `currency`, `foreignAmount` and `foreignOpen`.
- **Both invariants hold for each control account and are tested** (including a property test
  with random rates): open items sum to the balance in US dollars, and in the currency.
- Balances and statements for a foreign-currency party are in its currency. The statement is
  built from its documents and payments, since revaluations change nothing in the currency.
  A/R and A/P aging and the other reports stay in US dollars.

### Revaluation (unrealized gains and losses)

- **Currencies › Revalue currencies** previews, for each customer and vendor with an open
  foreign balance, as of a date:
  - the balance in the currency;
  - its US dollar value in the books;
  - its value at the rate on the date (the latest on or before it);
  - the gain or loss.
- **Posting** creates a `currency_revaluation` transaction on the date:
  - lines to each party's A/R or A/P (currency), foreign amounts zero, against Exchange Gain or
    Loss;
  - its **reversal the next day** (`reversal_of_id`).

  So later payments realize gains and losses from the documents' own rates without double
  counting, and the books show the revalued balance on the date.

- Voiding a revaluation voids its reversal.
- Revaluing a date twice finds nothing to change.

### Guards

- The posting engine enforces the currency rules for every source:
  - a line on a foreign-currency account must carry foreign amounts, and other lines can't;
  - a customer's or vendor's A/R or A/P line must be on the account of their currency.

  So **journal entries can't post to foreign-currency A/R or A/P**, or to US dollar A/R or A/P
  for a foreign-currency party.

- **Sales tax** isn't charged on foreign-currency documents yet (refused, open question 63).

## Consequences

- Foreign-currency customers and vendors work end to end: documents in their currency, books
  in US dollars, exact realized gains and losses, on-demand revaluation, and subledgers tied to
  the ledger in both currencies.
- **Not in this part:**
  - foreign-currency bank and credit card accounts, with transfers between currencies (10c-2,
    open question 62);
  - sales tax in a foreign currency (open question 63);
  - importing QuickBooks multi-currency companies (open question 64);
  - removing a currency;
  - changing a document's rate after payments are applied.
