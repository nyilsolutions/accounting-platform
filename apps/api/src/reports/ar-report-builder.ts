import { moneyToString, TXN_TYPE_LABELS, type Money, type ReportRow } from '@acct/shared';
import {
  AGING_BUCKETS,
  AGING_LABELS,
  agingOf,
  bucketOf,
  daysPastDue,
  type LedgerItem,
} from '../ledger/subledger';

/**
 * Receivables and payables report layouts. Pure functions over a subledger (open items as of the
 * report date), so they can be tested without a database. `party` decides whether rows drill down
 * to customers (A/R) or vendors (A/P).
 */

export type Party = 'customer' | 'vendor';
type Item = LedgerItem;

const NOT_SPECIFIED = 'Not specified';
const m = (v: Money) => moneyToString(v);

function partyKey(party: Party, id: string | null): Partial<ReportRow> {
  if (!id) return {};
  return party === 'customer' ? { customerId: id } : { vendorId: id };
}

function byParty(items: Item[]): Array<{ partyId: string | null; name: string; items: Item[] }> {
  const groups = new Map<string, { partyId: string | null; name: string; items: Item[] }>();
  for (const i of items) {
    const key = i.partyId ?? '';
    const g = groups.get(key) ?? {
      partyId: i.partyId,
      name: i.partyName ?? NOT_SPECIFIED,
      items: [],
    };
    g.items.push(i);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) =>
    a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
  );
}

const openOnly = (items: Item[]) => items.filter((i) => i.open !== 0n);

function partyRow(
  party: Party,
  label: string,
  id: string | null,
  amounts: Array<string | null>,
): ReportRow {
  return { kind: 'row', label, depth: 0, ...partyKey(party, id), amounts };
}

function itemRow(party: Party, i: Item, cells: Array<string | null>, depth = 1): ReportRow {
  return {
    kind: 'row',
    label: `${TXN_TYPE_LABELS[i.txnType] ?? i.txnType}${i.number ? ` ${i.number}` : ''}`,
    depth,
    txnId: i.txnId,
    txnType: i.txnType,
    ...partyKey(party, i.partyId),
    cells,
    amounts: [m(i.amount), m(i.open)],
  };
}

function pastDue(i: Item, asOf: string): string | null {
  const d = daysPastDue(i, asOf);
  return d > 0 ? String(d) : null;
}

export const AGING_COLUMNS = [...AGING_BUCKETS.map((b) => AGING_LABELS[b]), 'Total'];

/** One row per customer/vendor with the open balance split into aging buckets. */
export function agingSummary(items: Item[], asOf: string, party: Party = 'customer'): ReportRow[] {
  const rows: ReportRow[] = [];
  for (const g of byParty(openOnly(items))) {
    const a = agingOf(g.items, asOf);
    if (a.total === 0n && AGING_BUCKETS.every((b) => a[b] === 0n)) continue;
    rows.push(
      partyRow(party, g.name, g.partyId, [...AGING_BUCKETS.map((b) => m(a[b])), m(a.total)]),
    );
  }
  const t = agingOf(items, asOf);
  rows.push({
    kind: 'grand_total',
    label: 'TOTAL',
    depth: 0,
    amounts: [...AGING_BUCKETS.map((b) => m(t[b])), m(t.total)],
  });
  return rows;
}

export function agingDetailColumns(party: Party): string[] {
  return [
    'Date',
    'Transaction type',
    'Num',
    party === 'customer' ? 'Customer' : 'Vendor',
    'Due date',
    'Past due',
  ];
}

/** Every open item, grouped by aging bucket. */
export function agingDetail(items: Item[], asOf: string, party: Party = 'customer'): ReportRow[] {
  const rows: ReportRow[] = [];
  const open = openOnly(items);
  let grandAmount = 0n;
  let grandOpen = 0n;
  for (const bucket of AGING_BUCKETS) {
    const inBucket = open.filter((i) => bucketOf(i, asOf) === bucket);
    if (inBucket.length === 0) continue;
    const label = bucket === 'current' ? 'Current' : `${AGING_LABELS[bucket]} days past due`;
    rows.push({ kind: 'section', label, depth: 0, amounts: [null, null] });
    let amount = 0n;
    let openSum = 0n;
    for (const i of inBucket) {
      rows.push(
        itemRow(party, i, [
          i.txnDate,
          TXN_TYPE_LABELS[i.txnType] ?? i.txnType,
          i.number,
          i.partyName ?? NOT_SPECIFIED,
          i.dueDate,
          pastDue(i, asOf),
        ]),
      );
      amount += i.amount;
      openSum += i.open;
    }
    rows.push({
      kind: 'total',
      label: `Total for ${label}`,
      depth: 0,
      amounts: [m(amount), m(openSum)],
    });
    grandAmount += amount;
    grandOpen += openSum;
  }
  rows.push({
    kind: 'grand_total',
    label: 'TOTAL',
    depth: 0,
    amounts: [m(grandAmount), m(grandOpen)],
  });
  return rows;
}

export const OPEN_DOCUMENTS_TEXT_COLUMNS = [
  'Date',
  'Transaction type',
  'Num',
  'Due date',
  'Past due',
];

/**
 * Open invoices (or unpaid bills), unused credits and unapplied payments, grouped by customer
 * (or vendor).
 */
export function openDocuments(items: Item[], asOf: string, party: Party = 'customer'): ReportRow[] {
  const rows: ReportRow[] = [];
  let grandAmount = 0n;
  let grandOpen = 0n;
  for (const g of byParty(openOnly(items))) {
    rows.push({
      kind: 'section',
      label: g.name,
      depth: 0,
      ...partyKey(party, g.partyId),
      amounts: [null, null],
    });
    let amount = 0n;
    let openSum = 0n;
    for (const i of g.items) {
      rows.push(
        itemRow(party, i, [
          i.txnDate,
          TXN_TYPE_LABELS[i.txnType] ?? i.txnType,
          i.number,
          i.dueDate,
          pastDue(i, asOf),
        ]),
      );
      amount += i.amount;
      openSum += i.open;
    }
    rows.push({
      kind: 'total',
      label: `Total for ${g.name}`,
      depth: 0,
      amounts: [m(amount), m(openSum)],
    });
    grandAmount += amount;
    grandOpen += openSum;
  }
  rows.push({
    kind: 'grand_total',
    label: 'TOTAL',
    depth: 0,
    amounts: [m(grandAmount), m(grandOpen)],
  });
  return rows;
}

/** Open balance per customer (or vendor). */
export function balanceSummary(items: Item[], party: Party = 'customer'): ReportRow[] {
  const rows: ReportRow[] = [];
  let total = 0n;
  for (const g of byParty(openOnly(items))) {
    const sum = g.items.reduce((s, i) => s + i.open, 0n);
    if (sum === 0n) continue;
    rows.push(partyRow(party, g.name, g.partyId, [m(sum)]));
    total += sum;
  }
  rows.push({ kind: 'grand_total', label: 'TOTAL', depth: 0, amounts: [m(total)] });
  return rows;
}

export interface SalesAggregate {
  key: string | null;
  label: string;
  quantity: Money;
  amount: Money;
}

/**
 * Net amount per customer (sales: invoices and receipts less credits and refunds) or per vendor
 * (expenses: bills, checks and expenses less vendor and card credits).
 */
export function amountByParty(groups: SalesAggregate[], party: Party = 'customer'): ReportRow[] {
  const sorted = [...groups].sort((a, b) =>
    a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }),
  );
  const rows: ReportRow[] = sorted
    .filter((g) => g.amount !== 0n)
    .map((g) => partyRow(party, g.label, g.key, [m(g.amount)]));
  rows.push({
    kind: 'grand_total',
    label: 'TOTAL',
    depth: 0,
    amounts: [m(groups.reduce((s, g) => s + g.amount, 0n))],
  });
  return rows;
}

/** Sales by product/service: quantity, amount, share of sales and average price. */
export function salesByItem(groups: SalesAggregate[]): ReportRow[] {
  const total = groups.reduce((s, g) => s + g.amount, 0n);
  const sorted = [...groups].sort((a, b) =>
    a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }),
  );
  const rows: ReportRow[] = sorted
    .filter((g) => g.amount !== 0n || g.quantity !== 0n)
    .map((g) => ({
      kind: 'row' as const,
      label: g.label,
      depth: 0,
      amounts: [
        g.quantity !== 0n ? trimQty(g.quantity) : null,
        m(g.amount),
        total !== 0n ? percent(g.amount, total) : null,
        g.quantity !== 0n ? m(roundDiv(g.amount * 10_000n, g.quantity)) : null,
      ],
    }));
  rows.push({
    kind: 'grand_total',
    label: 'TOTAL',
    depth: 0,
    amounts: [null, m(total), total !== 0n ? '100.00' : null, null],
  });
  return rows;
}

function roundDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  const r = a % b;
  const abs = (v: bigint) => (v < 0n ? -v : v);
  return abs(r) * 2n >= abs(b) ? q + (a < 0n !== b < 0n ? -1n : 1n) : q;
}

/** Share of the total, as a percentage with 2 decimals. */
function percent(part: Money, total: Money): string {
  return moneyToString(roundDiv(part * 100n * 10_000n, total));
}

/** Quantities are stored with 4 decimals; show only the significant ones. */
function trimQty(q: Money): string {
  return moneyToString(q, 4).replace(/\.?0+$/, '');
}
