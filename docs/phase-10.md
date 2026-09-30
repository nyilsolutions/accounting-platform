# Phase 10: Advanced features

Phase 10 comes in six parts, each its own pull request, in this order (decided 2026-09-30):

| Part | What                                          | Status  |
| ---- | --------------------------------------------- | ------- |
| 10a  | Inventory                                     | This PR |
| 10b  | Time tracking and progress invoicing          | This PR |
| 10c  | Multi-currency                                | This PR |
| 10d  | Accountant tools                              | Planned |
| 10e  | Card and bank payments through Stripe Connect | Planned |
| 10f  | Customer, employee and contractor portals     | Planned |

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

| Suite                   | Count | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db`           | 97    | +6: multi-currency can't be turned off, currency codes, one positive rate per currency and date, foreign currencies only on one A/R and A/P each and never changed, a rate with every currency, isolation by company                                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/shared`       | 153   | +7: exact rates, conversion to the cent (with a property test against exact arithmetic), shares of a document's value, ECB cross rates, formatting, schemas                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/api`              | 509   | +20. **ECB (fixtures, no network):** daily and 90-day files, cross rates, weekends, failures. **End to end:** turning on and adding currencies; rates by hand, by lookup and from the feed (hand-entered kept); party currencies fixed once used; invoices booked line by line; realized gains on full, partial and over-payments, credit memos and bills; voiding a payment; balances, statements and aging; deposits in dollars; journal entries refused; sales tax refused; revaluation and its reversal; the cash basis; checks in dollars; a property test keeping every control account tied in dollars and in euros |
| `apps/web` (Playwright) | 15    | +1: turn on multi-currency, add EUR, enter a rate, a euro customer, an invoice with the rate filled in and its dollar value, a payment at a better rate with its $15 gain, a month-end revaluation, the chart of accounts in euros                                                                                                                                                                                                                                                                                                                                                                                         |

### Not in this part

- Foreign-currency bank and credit card accounts and transfers between currencies (10c-2,
  question 62).
- Sales tax on foreign-currency documents (question 63).
- Importing QuickBooks companies with multi-currency on (question 64).
