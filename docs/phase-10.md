# Phase 10: Advanced features

Phase 10 comes in six parts, each its own pull request, in this order (decided 2026-09-30):

| Part | What                                          | Status  |
| ---- | --------------------------------------------- | ------- |
| 10a  | Inventory                                     | This PR |
| 10b  | Time tracking and progress invoicing          | Next    |
| 10c  | Multi-currency                                | Planned |
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
