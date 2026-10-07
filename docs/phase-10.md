# Phase 10: Advanced features

Phase 10 comes in six parts, each its own pull request, in this order (decided 2026-09-30):

| Part | What                                          | Status  |
| ---- | --------------------------------------------- | ------- |
| 10a  | Inventory                                     | This PR |
| 10b  | Time tracking and progress invoicing          | This PR |
| 10c  | Multi-currency                                | This PR |
| 10d  | Accountant tools                              | This PR |
| 10e  | Card and bank payments through Stripe Connect | This PR |
| 10f  | Customer, employee and contractor portals     | This PR |

The owner's decisions for the later parts:

- **Multi-currency:** the home currency is USD, and it can't be turned off once it is on. Rates
  are entered by hand, with a European Central Bank daily feed behind an interface.
- **Stripe Connect:** needs the platform's Stripe account and keys; until then a stand-in is used.
- **Portals:** customers sign in with an emailed link; employees and contractors use a password
  and MFA.
- **Timesheets:** a payroll admin or manager approves them before they feed paychecks or invoices.

## 10a: Inventory (ADR 0018)

### Delivered

- **Inventory items and assemblies** (Sales › Products and services):
  - an inventory asset account (Inventory Asset by default, created on first use);
  - a cost of goods sold account;
  - a reorder point;
  - for assemblies, their components.

  The list shows each item's quantity on hand, highlighted at or below its reorder point.

- **Costing:** FIFO by default, or average cost, chosen in Company settings › Accounting. It is
  fixed once inventory has moved.
- **Buying and selling:**
  - bills, checks and expenses add stock at the line's amount;
  - invoices and sales receipts relieve it at cost to cost of goods sold;
  - credit memos and refunds bring it back at the current cost;
  - vendor credits return it.
- **No negative stock:** saving, changing or voiding anything that would leave an item short on
  any date is refused, naming the item, date, what was on hand and what was needed.
- **Backdating:** a transaction dated before others recosts them. For example, a bill entered
  after the sale it came before changes what that sale's goods cost. Each recalculated
  transaction gets a new version.
- **Inventory** page (`g h`):
  - stock on hand, with reorder flags;
  - **Adjust quantity:** enter the new quantity or the change, with a cost for stock added and the
    account for the value;
  - **Build assembly:** shows what each component needs against what's on hand;
  - the list of adjustments and builds, each of which can be edited, voided or deleted.
- **Start tracking items** (the QuickBooks cut-over, question 61):
  - converts non-inventory items to inventory from a date, with their quantity and value then;
  - after a QuickBooks import the value is already in the books, so nothing is posted; otherwise
    it is posted against an account;
  - transactions before the date stay as they are;
  - the first conversion after a QuickBooks import takes QuickBooks' costing method (Desktop:
    average, Online: FIFO);
  - reruns of the import keep converted items as inventory.
- **Reports** (Reports › Inventory):
  - Inventory Valuation Summary;
  - Inventory Valuation Detail;
  - Inventory Stock Status by Item (with open purchase order quantities).

  They export, memorize and schedule like the others.

### Demo script

1. Sign in to Sample Landscaping Co. and open **Inventory**:
   - paver stones bought at two prices;
   - polymeric sand flagged **Reorder**;
   - five patio paver kits built in September.
2. Open **Reports › Inventory Valuation Summary**. The total equals Inventory Asset on the Balance
   Sheet.
3. Open the **Inventory Valuation Detail**:
   - the pavers' two FIFO layers;
   - the kit build;
   - the Hillside HOA invoice;
   - the broken pavers written off.
4. Try an invoice for 10 patio kits: it is refused, since only four are on hand.
5. Add a bill for pavers dated in July at a lower price. The September build and invoice are
   recosted, and the valuation still matches the balance sheet.

Screenshots: `docs/screenshots/100-build-assembly.png`, `101-inventory.png`,
`102-inventory-valuation.png`, `103-start-tracking.png`.

### Tests

| Suite                   | Count | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/db`           | 88    | +4: inventory item accounts and reorder points, movement sign rules, inventory journal lines, the costing setting, start dates and starting values with no lines, isolation by company                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/api`              | 472   | +43. **Costing (pure):** FIFO and average worked examples, partial layers, backdating, selling everything, shortages, uncosted inflows, assemblies level by level, properties. **End to end:** default accounts, sales at cost, refusing to oversell, backdated purchases recosting sales, voids, returns both ways, locks, adjustments, builds and nested assemblies, reports, a random history keeping the inventory asset account equal to the value on hand, and the cut-over: converting items with their value already in the books or posted, earlier documents left alone, an IIF import's inventory part converted with Desktop's average costing and kept on a rerun |
| `apps/web` (Playwright) | 13    | +1: inventory items and an assembly through the product form, build five kits, count the stock, refuse to oversell, the valuation matching the balance sheet, the costing method locked, starting to track a non-inventory item                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### Not in this part

- Serial and lot numbers, locations and bins, units of measure, landed costs, pending builds.

## 10b: Time tracking and progress invoicing (ADR 0019)

### Delivered

- **Time** (`g g`), a weekly timesheet for any employee or contractor:
  - rows by customer, service, pay-as (regular, overtime, time off) and billable, with notes;
  - hours as 7.5 or 7:30;
  - **Save**, and **Submit for approval**;
  - submitted and approved time shows locked, rejected time shows its reason.
- **Approve time:** each person's submitted week, with hours and billable hours, to approve or
  reject with a reason.
  - Payroll admins (the new `time.approve` permission) approve anyone's time.
  - The manager named on an employee (Payroll › Employees, "Time approved by") approves that
    employee's.
- **Paychecks:** regular pay runs pay hourly employees their approved time in the period, by
  payroll item. The paycheck says where its hours came from and flags time in the period that
  isn't approved. Deleting a draft or voiding a paycheck frees its time.
- **Billing time:** **Add billable time** on invoices and sales receipts lists the customer's
  approved, billable time. Each chosen entry becomes a line (hours × rate). Time can be billed
  once; voiding the invoice frees it.
- **Progress invoicing:** **Create progress invoice** on an estimate, by percent, what remains, or
  an amount per line.
  - The estimate shows what has been invoiced and what remains.
  - It closes when fully invoiced and reopens if an invoice is voided.
  - Invoices can't bill more than an estimate line.
- **Reports** (Reports › Time and projects): Time by Customer Summary, Time Activities by Person
  Detail, Unbilled Time, Estimates Progress.

### Demo script

1. In Sample Landscaping Co., open **Time**:
   - Maria Lopez's last September week is approved;
   - the next week is waiting in **Approve time**; approve it.
2. Open a new invoice for Hillside HOA, then **Add billable time**: Maria's lawn service and
   Rivera Tree Service's four hours at $75.
3. Open the Oakwood Dental estimate:
   - 40% has been invoiced;
   - **Create progress invoice** for everything that remains;
   - the estimate closes.
4. **Reports › Estimates Progress** and **Unbilled Time**.

Screenshots: `docs/screenshots/104-timesheet.png`, `105-approve-time.png`,
`106-progress-invoice.png`.

### Tests

| Suite                   | Count | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db`           | 91    | +3: an employee or a vendor, never both; hours within a day; billable time names a customer; only approved time is paid or billed; isolation by company                                                                                                                                                                                                                                                                                                                                                                                   |
| `apps/api`              | 489   | +17 end to end: a time tracking user's weekly timesheet, submitted time locked, contractors' time, approvals by payroll admins and managers only, rejection with a reason and resubmission, pay runs paying approved time by payroll item with notices, freeing time when a draft run is deleted, billing time once, voids freeing it, the time reports, progress invoicing by percent (quantities shared), refusing to invoice more than a line (also by editing), closing and reopening the estimate, and the Estimates Progress report |
| `apps/web` (Playwright) | 14    | +1: a weekly timesheet in the grid, submit, approve, bill the time with Add billable time, a 30% progress invoice, the estimate's progress and the report                                                                                                                                                                                                                                                                                                                                                                                 |

### Not in this part

- Overtime calculated from hours worked (FLSA weekly, California daily): time is paid as the
  payroll item it was entered as.
- A start/stop timer, billable expenses, and time entry by employees themselves (portals, 10f).

## 10c: Multi-currency (ADR 0020)

### Delivered

- **Company settings › Currencies:**
  - turn on multi-currency (it can't be turned off; the home currency stays US dollars);
  - add currencies, each with its own Accounts Receivable and Accounts Payable account;
  - Exchange Gain or Loss is created.
- **Accounting › Currencies**, exchange rates in US dollars per unit:
  - entered by hand for a date;
  - or **Get today's rates from the European Central Bank**, which keeps any rate entered by
    hand for that date.
- **Customers and vendors** have a currency. It can't change once they have transactions.
- **Documents** in the party's currency:
  - invoices, sales receipts, credit memos, refund receipts, bills, vendor credits, checks and
    expenses;
  - the exchange rate comes from the rate on file for the date, or is typed on the document;
  - the form shows the US dollar value;
  - each line posts in US dollars to the currency's A/R or A/P.
- **Sales tax** on foreign-currency invoices: calculated in the currency and recorded for each
  agency in US dollars at the invoice's rate (question 63).
- **Payments and bill payments** in the party's currency, at the payment's rate:
  - what each invoice or bill is worth at its own rate is relieved;
  - the difference is the **realized exchange gain or loss**, shown on the payment.
- **Money moves in dollars:**
  - deposits take foreign payments at their US dollar value;
  - checks print the dollars paid;
  - pay bills uses the rate on file for the payment date.
- **Balances in the party's currency:**
  - customer and vendor lists show balances in their currency, with the US dollar value;
  - statements are in the customer's currency;
  - the chart of accounts shows A/R and A/P (currency) in the currency too.
- **Reports stay in US dollars:** P&L, balance sheet, aging, sales by customer and item,
  expenses by vendor, and the cash basis (which recognizes a paid invoice at its rate plus the
  gain or loss).
- **Revalue currencies:**
  - previews each party's open foreign balance at a date's rate against its value in the books;
  - posts the unrealized gain or loss to Exchange Gain or Loss;
  - reverses it the next day;
  - voiding it voids both.

### Demo script

1. In Sample Landscaping Co., open **Company settings › Currencies**: CAD and EUR, with rates for
   late August and September.
2. **Accounting › Currencies**: the rates.
   - **Get today's rates from the European Central Bank** needs network access to the ECB.
3. **Maple Leaf Gardens Ltd.** (Canadian dollars):
   - invoice CA-1001 for C$2,400.00 at 0.7310 ($1,754.40), paid at 0.7402 ($1,776.48): a
     $22.08 gain on the payment;
   - CA-1002 for C$1,850.00 is open.
4. **Hortus Seeds B.V.** (euros): bill HS-3391 for €1,500.00 at 1.0820 ($1,623.00), paid at
   1.0935 ($1,640.25): a $17.25 loss.
5. **Revalue currencies** as of September 30: CA-1002 at 0.7342, a small loss.
   - Post it, then look at the balance sheet on September 30 and October 1.

Screenshots: `docs/screenshots/107-exchange-rates.png`, `108-foreign-invoice.png`,
`109-revaluation.png`.

### Tests

| Suite                   | Count | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db`           | 97    | +6: multi-currency can't be turned off, currency codes, one positive rate per currency and date, foreign currencies only on one A/R and A/P each and never changed, a rate with every currency, isolation by company                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/shared`       | 153   | +7: exact rates, conversion to the cent (with a property test against exact arithmetic), shares of a document's value, ECB cross rates, formatting, schemas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/api`              | 509   | +20. **ECB (fixtures, no network):** daily and 90-day files, cross rates, weekends, failures. **End to end:** turning on and adding currencies; rates by hand, by lookup and from the feed (hand-entered kept); party currencies fixed once used; invoices booked line by line; realized gains on full, partial and over-payments, credit memos and bills; voiding a payment; balances, statements and aging; deposits in dollars; journal entries refused; sales tax charged in euros and recorded in dollars; revaluation and its reversal; the cash basis; checks in dollars; a property test keeping every control account tied in dollars and in euros |
| `apps/web` (Playwright) | 15    | +1: turn on multi-currency, add EUR, enter a rate, a euro customer, an invoice with the rate filled in and its dollar value, a payment at a better rate with its $15 gain, a month-end revaluation, the chart of accounts in euros                                                                                                                                                                                                                                                                                                                                                                                                                          |

### Not in this part

- Foreign-currency bank and credit card accounts and transfers between currencies (10c-2,
  question 62).
- Importing QuickBooks companies with multi-currency on (question 64: waits on a sample file).

## 10d: Accountant tools (ADR 0021)

### Delivered

- **Accounting › Accountant tools**, one page per tool, for people with `ledger.manage`:
- **Reclassify transactions:**
  - filter posted lines by account, class, customer or vendor, dates and type;
  - move the chosen lines to another account and/or class in one step;
  - amounts don't change; each transaction gets a new version;
  - invoices, receipts, credit memos, bills, checks and expenses change their own lines too, so
    a later edit keeps the new account;
  - product and service lines keep the item's account (only the class moves);
  - A/R, A/P, bank, card, sales tax, payroll and inventory lines are never listed;
  - lines in a closed period need the closing password.
- **Write off invoices:**
  - open invoices at least N days past due as of a date;
  - each one's balance goes to Bad Debts (created on first use) through a credit memo applied by
    a payment of zero, in the invoice's currency at its rate;
  - the sales tax on the invoice stays owed to the agency.
- **Fix undeposited funds:**
  - what is waiting in Undeposited Funds, and deposit lines entered straight to income for a
    customer;
  - replaces such a line with the customer's waiting payments that add up to it, so income isn't
    counted twice; the bank amount doesn't change.
- **Review client changes:**
  - transactions and accounts added, changed, voided or deleted by anyone who isn't the
    company's accountant, from the audit log, with before and after;
  - changes in a closed period are flagged;
  - mark them reviewed one by one or all shown at once, and unmark.
- **Close the books**, a month-end checklist worked out live:
  - every bank and card account reconciled through the month end;
  - Undeposited Funds empty;
  - nothing uncategorized in the month;
  - client changes to the month or earlier reviewed;
  - a revaluation dated the month end, if foreign-currency balances are open;
  - the A/R and A/P aging looked over (marked by hand).

  Any step can be marked done by hand with a note. **Close** is allowed once nothing needs
  attention: it sets the closing date and password and records the close with a snapshot of the
  checklist.

- **Adjusted Trial Balance** report: unadjusted balances, adjusting entries and adjusted
  balances, each as debit and credit.

### Demo script

1. In Sample Landscaping Co., open **Accounting › Accountant tools**.
2. **Fix undeposited funds:** Hillside HOA's $320 check (September 12) waits in Undeposited
   Funds, and the September 13 deposit put $320 straight to Services. **Match to 1 payment**.
3. **Reclassify:** filter by Uncategorized Expense. Move the $64.50 HOMEDEPOT #4410 expense
   (September 18) to Repairs and Maintenance.
4. **Write off invoices:** OLD-17, Oakwood Dental's disputed $85 hedge trim from March. Write it
   off; the invoice is paid and Bad Debts shows $85.
5. **Review client changes:** the demo's changes, then **Mark all shown reviewed**.
6. **Close the books** for August: mark the bank step with a note (the demo's bank isn't
   reconciled), mark the aging step, set a closing password and close.
7. **Reports › Adjusted Trial Balance** through August 31: the $215.40 utilities accrual
   (to Accrued Liabilities) in the adjustments columns.

Screenshots: `docs/screenshots/110-fix-undeposited.png`, `111-reclassify.png`,
`112-close-books.png`.

### Tests

| Suite                   | Count | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db`           | 99    | +2: reviews, checklist marks and closes isolated by company; only the checklist's steps; closes kept as history (never changed or deleted)                                                                                                                                                                                                                                                                                                                                                                                                     |
| `apps/api`              | 518   | +8: the Adjusted Trial Balance; reclassify listing only lines that can move, moving accounts and classes as a new version with the documents' lines, keeping product accounts, a standard user refused, a closed period needing the password; writing off old invoices to Bad Debts with the tax still owed; replacing a deposit line with the waiting payment; client changes (not the accountant's) until reviewed; the checklist worked out live, marks with notes, closing refused until ready, then the month closed and closed only once |
| `apps/web` (Playwright) | 16    | +1: fix undeposited funds, reclassify an uncategorized expense, write off an old invoice, review the client's changes, close March with marks and a closing password, the Adjusted Trial Balance                                                                                                                                                                                                                                                                                                                                               |

### Not in this part

- A list of every client's checklist and changes for accountants with many clients.

## 10e: Online invoice payments through Stripe Connect (ADR 0022)

The owner's decisions (2026-10-07):

- Standard accounts, each business with its own Stripe account.
- The business pays the fees.
- QuickBooks-style recording.
- No platform fee.
- Refunds go to Refunds and Allowances and chargebacks to Chargebacks.

The platform's Stripe account and keys aren't set up yet, so a **stand-in** plays Stripe in
development and the demo (question 66).

### Delivered

- **Company settings › Online payments:**
  - connect Stripe: choose the bank account payouts go to, then Stripe's onboarding;
  - the account's status, and what Stripe still needs;
  - card and/or bank transfer (ACH);
  - the accounts for payouts, fees (Merchant Fees), refunds (Refunds and Allowances) and
    chargebacks (Chargebacks), created when first needed;
  - disconnect.
- **Pay links:**
  - emailed invoices with a balance include a link to pay online;
  - **Get payment link** on the invoice gives one to copy;
  - the invoice shows its online payments.
- **The pay page** (no sign-in):
  - the invoice, its balance and a button per way to pay;
  - Stripe Checkout for the whole balance, on the business's own account;
  - bank payments show as on their way until they clear.
- **Recording:**
  - a successful payment becomes a Receive Payment into Undeposited Funds, applied to the
    invoice;
  - each Stripe payout becomes one bank deposit: its payments, less refunds, chargebacks and
    one line for Stripe's fees, equal to what reached the bank.
- **Sales › Online payments:**
  - payments with their status, refunds and disputes;
  - payouts with what they carried and their deposit;
  - payouts that couldn't be matched wait for review (**Try again** or **Mark recorded**);
  - payments the books refused (a closed period) can be recorded later.
- **Deposits** can now have negative lines (fees, refunds, cash back) if the total stays
  positive.
- **Stripe itself** is called over its REST API with signed Connect webhooks. It is tested
  against a fake Stripe API and goes live with configuration only.

### Demo script

1. In Sample Landscaping Co., open **Company settings › Online payments**: connected to the
   stand-in, taking card and bank payments.
2. **Sales › Online payments**:
   - Oakwood Dental paid ONL-1001 ($480.00) by card;
   - Hillside HOA paid ONL-1002 ($1,250.00) by bank transfer;
   - one payout of $1,710.78 was deposited to Checking ($1,730.00 less $19.22 of stand-in fees).
     Open the deposit to see the fee line.
3. Open invoice **ONL-1003** (Oakwood Dental, $195.00) and choose **Get payment link**. Open the
   link in a private window, pay by card on the stand-in's checkout, and the page says it's paid.
4. Back in **Sales › Online payments**, choose **Refund (stand-in)** on it, then **Pay out now
   (stand-in)**. The deposit nets the payment, the refund and the fee.

Screenshots: `docs/screenshots/113-online-payments-settings.png`, `114-pay-invoice.png`,
`115-online-payments.png`.

### Tests

| Suite                   | Count | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/db`           | 103   | +4: everything kept within the company; the lookups without a tenant return only ids; one company per Stripe account; each event once; a succeeded payment needs its Receive Payment; negative deposit lines but never from Undeposited Funds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/api`              | 540   | +22. **Stripe (fake API, no network):** cents, form encoding, Standard accounts and onboarding, checkout as a direct charge with no platform fee, payments, paged payout items, Stripe's error messages, signed and stale webhooks. **Stand-in:** fees, cards, bank payments, refunds, payouts. **End to end:** connecting (bank account, permissions, onboarding to active), settings, emailed links, card payments into Undeposited Funds, events handled once, bank payments failing then clearing, a payout deposit with fees and a refund, chargebacks, unmatched payouts left for review, a closed period then recording later, foreign-currency invoices refused, disconnecting revokes links, deposits with negative lines, and the Stripe processor through signed webhooks |
| `apps/web` (Playwright) | 17    | +1: connect the stand-in from Company settings, get an invoice's payment link, pay it by card as the customer, pay out, and the deposit net of the fee                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### Not in this part

- Paying foreign-currency invoices online (question 67).
- Paying part of an invoice (question 68).
- Refunds started from the app (question 69).
- Saved cards and automatic recurring charges.

## 10f: Customer, employee and contractor portals (ADR 0023)

The owner's decisions (2026-10-07):

- **Customers** view their invoices, pay them and accept or decline estimates.
- **Employees** see their pay stubs and W-2 figures and enter their time; W-4 and direct deposit
  changes are requests a payroll admin approves.
- **Contractors** enter their time and see their payments and 1099 totals.
- Employees and contractors use the normal sign-in, linked to their own record, never a company
  membership.

### Delivered

- **Inviting employees and contractors:** a **Portal access** card on the employee page
  (payroll managers) and on the vendor page (purchases managers).
  - It emails an invitation the person accepts with their own account (password and MFA).
  - The card shows whether they accepted.
  - **Remove access** ends it at once.
- **The employee portal** (`/portal`):
  - **Pay stubs**, the same statement staff see, printable;
  - **W-2** figures by year (the year so far);
  - **Time**, a weekly timesheet submitted to the normal approvals;
  - **W-4 and direct deposit**: what is on file (accounts masked), with **Change my W-4** and
    **Change my account** sending requests.
- **Employee requests** (Payroll › Employee requests):
  - each request with its summary;
  - **Approve** applies it through the payroll services (new accounts are prenoted);
  - **Reject** takes a note;
  - the employee and the approvers are emailed.

  Bank account numbers in a request are stored only encrypted and never shown or logged.

- **The contractor portal:** **Payments** by year, **1099** totals by box, and **Time**.
- **The customer portal** (`/portal/customer`): customers ask for a sign-in link by email (one
  use, 15 minutes), or the business sends one from the customer's page (**Invite to customer
  portal**, 7 days). In it:
  - their balance;
  - **Invoices** (open, overdue, paid), each printable with **Pay online** (10e);
  - **Statement** for any dates;
  - **Estimates** to **accept** or **decline**.

  Its session uses its own cookie, separate from staff sign-in.

- Someone with portal access but no companies goes straight to their portal after signing in.

### Demo script

1. Sign in as the demo user. The demo login is also linked to employee **Maria Lopez**'s portal:
   open `/portal` to see her pay stubs, W-2 figures and time.
2. **Payroll › Employee requests**: Maria asked for a new W-4 (married filing jointly, $4,000
   of dependents, from January 1). Approve it, and her W-4 history on the employee page has the
   new certificate.
3. Open **Sales › Customers › Oakwood Dental** and choose **Invite to customer portal**. The
   development mail transport prints the email; open its link to see Oakwood's invoices
   (including ONL-1003, payable online), statement and estimates.
4. Invite an employee or vendor from their page and open the printed invitation in a private
   window to create a portal account.

Screenshots: `docs/screenshots/116-portal-pay-stub.png`, `117-employee-requests.png`,
`118-customer-portal.png`.

### Tests

| Suite                   | Count | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db`           | 107   | +4: kept within the company; lookups without a company return ids and names only; one live link per worker and per person per company; one open request of each kind, bank details only encrypted, requests never deleted                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `apps/api`              | 552   | +12. **Invitations:** only the invited email accepts, with the right permission. **No books:** a portal user gets 404 on every company route and on other companies' portals. **Employees:** their own pay stubs only, W-2 figures, own timesheet submitted to approvals; W-4 requests approved into the history with emails; bank requests stored encrypted (not in the audit log), approved with prenotes; withdraw and reject. **Contractors:** payments, 1099 totals and time; access revoked. **Customers:** links never say whether an email is known, links work once, invoices with statuses, others' invoices refused, statement, estimates accepted once, signing out, staff-sent invitations |
| `apps/web` (Playwright) | 18    | +1: invite an employee from her page, she creates her account and sees her pay stub, asks for a new W-4, the owner approves it; a customer signs in by email, sees the balance and invoices, and accepts an estimate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### Not in this part

- Official W-2 copies and their electronic delivery, which needs the employee's consent
  (question 72).
- Earnings and customers on portal timesheets (question 71).
- State withholding certificate requests (question 73).
