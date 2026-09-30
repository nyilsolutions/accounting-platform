import { sql } from '@acct/db';
import {
  addDays,
  moneyToString,
  parseMoney,
  TXN_TYPE_LABELS,
  type Money,
  type ReportDto,
  type ReportQuery,
  type ReportRow,
} from '@acct/shared';
import { percentOf } from './report-builder';
import { reportDto, type ReportScope } from './report-scope';

/**
 * Inventory reports (ADR 0018), from inventory_moves: every quantity change of a posted
 * transaction, with the value costing gave it. The value on hand on a date is the sum of the
 * moves' costs up to it, which is what the inventory asset accounts hold.
 */

const m = (v: Money) => moneyToString(v);
const ONE = 10_000n;
/** A quantity without trailing zeros. */
function qty(v: Money): string {
  const s = moneyToString(v, 4).replace(/\.?0+$/, '');
  return s === '' || s === '-' ? '0' : s;
}
/** value ÷ quantity, to the cent. */
function unit(value: Money, quantity: Money): Money {
  if (quantity === 0n) return 0n;
  const q = (value * ONE * 2n) / quantity;
  return ((q + (q < 0n ? -100n : 100n)) / 200n) * 100n;
}

interface ItemRow {
  id: string;
  name: string;
  sku: string | null;
  item_type: string;
  sales_price: string | null;
  reorder_point: string | null;
  is_active: boolean;
}

async function stockedItems(scope: ReportScope): Promise<ItemRow[]> {
  return scope.tx
    .selectFrom('items')
    .select(['id', 'name', 'sku', 'item_type', 'sales_price', 'reorder_point', 'is_active'])
    .where('company_id', '=', scope.companyId)
    .where('item_type', 'in', ['inventory', 'assembly'])
    .orderBy('name')
    .execute();
}

/** Quantity and value on hand per item at the end of `date`. */
async function onHandAt(scope: ReportScope, date: string) {
  const rows = await scope.tx
    .selectFrom('inventory_moves')
    .select(['item_id'])
    .select((eb) => [
      eb.fn.sum<string>('quantity').as('qty'),
      eb.fn.sum<string>('cost').as('value'),
    ])
    .where('company_id', '=', scope.companyId)
    .where('move_date', '<=', date)
    .groupBy('item_id')
    .execute();
  return new Map(
    rows.map((r) => [r.item_id, { qty: parseMoney(r.qty), value: parseMoney(r.value) }]),
  );
}

/** Quantity, average cost, value and retail value of each item on hand on a date. */
export async function inventoryValuationSummaryReport(
  scope: ReportScope,
  q: ReportQuery,
): Promise<ReportDto> {
  const items = await stockedItems(scope);
  const onHand = await onHandAt(scope, q.to);
  const lines = items
    .map((i) => {
      const oh = onHand.get(i.id) ?? { qty: 0n, value: 0n };
      const price = i.sales_price === null ? null : parseMoney(i.sales_price);
      const retail = price === null ? null : (price * oh.qty) / ONE;
      return { item: i, ...oh, price, retail: retail === null ? null : (retail / 100n) * 100n };
    })
    // Inactive items with nothing on hand are left out.
    .filter((l) => l.item.is_active || l.qty !== 0n || l.value !== 0n);
  const totalValue = lines.reduce((s, l) => s + l.value, 0n);
  const totalRetail = lines.reduce((s, l) => s + (l.retail ?? 0n), 0n);
  const rows: ReportRow[] = lines.map((l) => ({
    kind: 'row',
    label: l.item.name,
    depth: 0,
    cells: [l.item.name, l.item.sku, qty(l.qty)],
    amounts: [
      l.qty > 0n ? m(unit(l.value, l.qty)) : null,
      m(l.value),
      percentOf(l.value, totalValue),
      l.price === null ? null : m(l.price),
      l.retail === null ? null : m(l.retail),
    ],
  }));
  rows.push({
    kind: 'grand_total',
    label: 'TOTAL',
    depth: 0,
    cells: ['TOTAL', null, null],
    amounts: [null, m(totalValue), totalValue ? '100.00' : null, null, m(totalRetail)],
  });
  return reportDto(
    scope,
    'inventory_valuation_summary',
    'accrual',
    null,
    q.to,
    ['Avg cost', 'Asset value', '% of total', 'Sales price', 'Retail value'],
    rows,
    null,
    { textColumns: ['Product/service', 'SKU', 'Qty on hand'], percentColumns: [2] },
  );
}

/**
 * Each item's quantity changes in the period, with what each cost and the running quantity and
 * value, starting from what was on hand before the period.
 */
export async function inventoryValuationDetailReport(
  scope: ReportScope,
  q: ReportQuery,
): Promise<ReportDto> {
  const from = q.from ?? q.to;
  const items = await stockedItems(scope);
  const before = await onHandAt(scope, addDays(from, -1));
  const moves = await sql<{
    item_id: string;
    transaction_id: string;
    txn_type: string;
    txn_number: string | null;
    move_date: string;
    name: string | null;
    quantity: string;
    cost: string;
  }>`
    select m.item_id, m.transaction_id, t.txn_type, t.txn_number, m.move_date::text as move_date,
           coalesce(c.display_name, v.display_name) as name, m.quantity, m.cost
    from inventory_moves m
    join transactions t on t.id = m.transaction_id
    left join customers c on c.id = t.customer_id
    left join vendors v on v.id = t.vendor_id
    where m.company_id = ${scope.companyId} and m.move_date between ${from} and ${q.to}
    order by m.item_id, m.move_date, t.created_at, t.id, m.seq`.execute(scope.tx);
  const byItem = new Map<string, typeof moves.rows>();
  for (const r of moves.rows) byItem.set(r.item_id, [...(byItem.get(r.item_id) ?? []), r]);

  const rows: ReportRow[] = [];
  let grand = 0n;
  for (const i of items) {
    const start = before.get(i.id) ?? { qty: 0n, value: 0n };
    const own = byItem.get(i.id) ?? [];
    if (own.length === 0 && start.qty === 0n && start.value === 0n) continue;
    rows.push({
      kind: 'section',
      label: i.name,
      depth: 0,
      cells: [i.name, null, null, null, null, null],
      amounts: [null, null],
    });
    let onHand = start.qty;
    let value = start.value;
    rows.push({
      kind: 'row',
      label: 'Beginning balance',
      depth: 1,
      cells: ['Beginning balance', null, null, null, null, qty(onHand)],
      amounts: [null, m(value)],
    });
    for (const r of own) {
      const quantity = parseMoney(r.quantity);
      const cost = parseMoney(r.cost);
      onHand += quantity;
      value += cost;
      rows.push({
        kind: 'row',
        label: r.move_date,
        depth: 1,
        txnId: r.transaction_id,
        txnType: r.txn_type,
        cells: [
          r.move_date,
          TXN_TYPE_LABELS[r.txn_type] ?? r.txn_type,
          r.txn_number,
          r.name,
          qty(quantity),
          qty(onHand),
        ],
        amounts: [m(cost), m(value)],
      });
    }
    rows.push({
      kind: 'total',
      label: `Total ${i.name}`,
      depth: 0,
      cells: [`Total ${i.name}`, null, null, null, qty(onHand - start.qty), qty(onHand)],
      amounts: [m(value - start.value), m(value)],
    });
    grand += value;
  }
  rows.push({
    kind: 'grand_total',
    label: 'TOTAL',
    depth: 0,
    cells: ['TOTAL', null, null, null, null, null],
    amounts: [null, m(grand)],
  });
  return reportDto(
    scope,
    'inventory_valuation_detail',
    'accrual',
    from,
    q.to,
    ['Cost', 'Asset value'],
    rows,
    null,
    { textColumns: ['Date', 'Transaction type', 'No.', 'Name', 'Qty', 'On hand'] },
  );
}

/**
 * What's on hand against each item's reorder point, and what's on open purchase orders. Items at
 * or below their reorder point (counting what's on order) are flagged.
 */
export async function inventoryStockStatusReport(
  scope: ReportScope,
  q: ReportQuery,
): Promise<ReportDto> {
  const items = await stockedItems(scope);
  const onHand = await onHandAt(scope, q.to);
  const ordered = await scope.tx
    .selectFrom('purchase_order_lines as l')
    .innerJoin('purchase_orders as p', 'p.id', 'l.purchase_order_id')
    .select(['l.item_id'])
    .select((eb) => eb.fn.sum<string>('l.quantity').as('qty'))
    .where('l.company_id', '=', scope.companyId)
    .where('p.status', '=', 'open')
    .where('l.item_id', 'is not', null)
    .groupBy('l.item_id')
    .execute();
  const onOrder = new Map(ordered.map((o) => [o.item_id!, parseMoney(o.qty ?? '0')]));
  const rows: ReportRow[] = items
    .filter((i) => i.is_active)
    .map((i) => {
      const oh = onHand.get(i.id) ?? { qty: 0n, value: 0n };
      const po = onOrder.get(i.id) ?? 0n;
      const reorder = i.reorder_point === null ? null : parseMoney(i.reorder_point);
      const flag = reorder !== null && oh.qty + po <= reorder;
      return {
        kind: 'row' as const,
        label: i.name,
        depth: 0,
        cells: [
          i.name,
          i.sku,
          reorder === null ? null : qty(reorder),
          qty(oh.qty),
          qty(po),
          flag ? 'Reorder' : null,
        ],
        amounts: [m(oh.value)],
      };
    });
  return reportDto(
    scope,
    'inventory_stock_status',
    'accrual',
    null,
    q.to,
    ['Asset value'],
    rows,
    null,
    {
      textColumns: ['Product/service', 'SKU', 'Reorder point', 'On hand', 'On PO', 'Order'],
    },
  );
}
