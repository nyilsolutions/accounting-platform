# ADR 0018: Inventory (Phase 10a)

- Status: Accepted
- Date: 2026-09-30

## Context

Phase 10 adds the advanced features, in six parts, each its own pull request: inventory (10a),
time tracking and progress invoicing (10b), multi-currency (10c), accountant tools (10d), Stripe
payments (10e) and portals (10f).

For inventory, the owner decided (2026-09-30, "go with your recommendations"):

1. **Costing:** FIFO for new companies, average cost as the other choice. QuickBooks imports keep
   their method (Desktop: average, QuickBooks Online: FIFO). The method can't change once
   inventory has moved.
2. **Negative stock:** refused, with a clear message.

What inventory needs, as in QuickBooks:

- inventory and assembly items, each with an inventory asset account, a cost of goods sold account
  and a reorder point;
- purchases that add stock at cost;
- sales that relieve it at cost to cost of goods sold;
- returns both ways;
- quantity adjustments;
- assembly builds;
- valuation and stock status reports.

The hard part is that transactions are entered out of order. A bill dated before an invoice that
has already been saved changes what that invoice's goods cost, and QuickBooks recalculates it.

## Decision

### Items

- Item types `inventory` and `assembly` (migration 0018). Both carry an `asset_account_id` and
  use `expense_account_id` as their cost of goods sold account; a check constraint requires both.
- The first inventory item creates (or adopts, by name) the **Inventory Asset** system account
  (`inventory_asset`), and defaults to **Cost of Goods Sold**.
- `reorder_point` is for inventory items only.
- An assembly lists its components in `assembly_components`. Components are inventory items or
  other assemblies, and never the assembly itself, directly or through other assemblies.
- An item used on transactions can't change to or from an inventory type.
- An item that has moved can't change its asset account (its value is in the old one). Its cost of
  goods sold account can change; later movements use the new one.

### Movements

`inventory_moves` holds one row per quantity change of a **posted** transaction: the item, date,
kind, signed quantity and the value costing gave it (`cost`, signed like the quantity).

| Kind              | From                              | Quantity | Cost                               |
| ----------------- | --------------------------------- | -------- | ---------------------------------- |
| `purchase`        | bill, check, expense line         | +        | the line's amount (fixed)          |
| `purchase_return` | vendor credit, credit card credit | −        | costing                            |
| `sale`            | invoice, sales receipt            | −        | costing                            |
| `sale_return`     | credit memo, refund receipt       | +        | current cost                       |
| `adjustment`      | inventory quantity adjustment     | ±        | given unit cost, else current cost |
| `build_consume`   | build (each component)            | −        | costing                            |
| `build_produce`   | build (the assembly)              | +        | the sum of its components' cost    |

- Moves are **derived data**: saving a transaction replaces its moves, and voiding or deleting it
  removes them.
- Each move stores the accounts it posts to (the item's asset account, and cost of goods sold or
  the adjustment account) and its class. Recosting an old transaction then posts to the same
  accounts even after the item's accounts are edited.

### Costing (`inventory/costing.ts`, pure)

- **FIFO:** outflows take the oldest layers first.
- **Average:** outflows take the on-hand value times the share of the quantity taken.
- **Rounding:** values are rounded to the cent. Taking everything on hand takes all of its value,
  so rounding never leaves value without quantity.
- **Inflows without a cost** (customer returns, additions at "current cost") come in at the
  current average. If nothing is on hand, they use the last unit cost, else the item's cost.
- **Order:** moves are ordered by date, then by when their transaction was first entered, then by
  line.
- **Shortage:** an outflow larger than what's on hand is a shortage, and the save is refused:
  "Not enough "Paver" on hand on 2026-01-10: 5 on hand, 10 needed."
- **Assemblies:** costs are iterated until they settle. A build's cost comes from its components,
  and an assembly of assemblies takes one more round per level.
- **Tests:** worked examples (FIFO $80 for 15 of 10 @ $5 and 10 @ $6; average $82.50) and
  fast-check properties (value = inflows − outflows, never negative, whole cents, FIFO leaves the
  newest layers).

### Posting (`inventory/inventory.service.ts`)

1. A document asks `InventoryService.plan()` for its inventory lines.
2. The plan costs the document's proposed moves with every stored move of the same items: the
   assemblies built from them, and all components of those builds, down to plain items. A
   shortage anywhere in that history is refused.
3. The plan returns the document's **inventory lines**: journal lines tagged
   `journal_lines.role = 'inventory'`. The document posts them with its own lines, once, through
   `PostingService`.
4. `commit()` then saves the moves. For every other transaction whose costs changed,
   `PostingService.replaceRoleLines` writes a new version: only its inventory lines change, the
   rest is carried over, and the closing date still applies.
5. Voiding or deleting runs the same plan with no moves, so it can be refused if later sales
   depend on the stock.

Inventory lines by kind:

- **Sale:** Dr cost of goods sold, Cr inventory asset, at cost. A customer return is the reverse.
- **Return to vendor:** the document line credits cost of goods sold with the amount credited.
  The inventory lines move the cost from the asset to cost of goods sold, so any difference stays
  in cost of goods sold.
- **Purchase:** no inventory lines; the document line itself debits the asset at its amount.
  Inventory item lines on purchases always post to the item's asset account (or cost of goods sold
  on returns), whatever account is chosen.
- **Adjustment:** the asset against the adjustment account.
- **Build:** Cr each component's asset, Dr the assembly's asset.

An adjustment or build whose value is zero (stock added at no cost) has no journal lines. The
balance trigger allows that for these two types only (migration 0018 redefines
`app_check_transaction_balanced`, keeping 0005's credit-only payments).

The **invariant**, tested with a random history of backdated purchases, sales and voids: each
inventory asset account equals the value of the items on hand in it.

### Documents

- **Inventory quantity adjustments** (`inventory_adjustment`): lines of item, quantity change,
  unit cost (additions only), account and class. The screen takes a new quantity or a change.
- **Assembly builds** (`inventory_build`): an assembly and a quantity. The components come from
  the assembly as it is when the build is saved.
- Both are under Inventory (`inventory.manage`, given to every role that enters transactions),
  and can be voided or deleted like other transactions.
- Sales and purchase lines for inventory items need a quantity above zero, and on purchases an
  amount of zero or more.

### Reports

In the reports hub, under Inventory:

- **Inventory Valuation Summary:** quantity, average cost, asset value, share of total, sales
  price and retail value, as of a date;
- **Inventory Valuation Detail:** each item's movements in a period, with running quantity and
  value;
- **Inventory Stock Status by Item:** on hand, on open purchase orders, and whether to reorder.

Items list their quantity on hand and value; the Inventory page shows stock, reorder flags and
recent adjustments and builds.

### Costing method

`companies.inventory_costing` (`fifo` default, or `average`). It is set in Company settings ›
Accounting, and refused once any movement exists.

## Consequences

- Backdated entries recost later transactions automatically and keep the books tied to stock. The
  price is that saving an early transaction can write new versions of later ones, each audited
  through its version history.
- **QuickBooks imports** bring inventory items as non-inventory, with their history as
  QuickBooks posted it (cost of goods sold arrives with the imported GL lines). Tracking their
  quantities here is open question 61.
- A journal entry posted straight to an inventory asset account changes the account but not the
  stock, and then the valuation report no longer agrees with the balance sheet. Use an adjustment
  instead.
- Not in this part: serial and lot numbers, multiple locations or bins, units of measure, landed
  costs, and "pending builds" that wait for components.
