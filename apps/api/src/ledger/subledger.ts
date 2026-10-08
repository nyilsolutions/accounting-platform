import { sql, type Tx } from '@acct/db';
import { moneyToString, parseMoney, type AgingBuckets, type Money } from '@acct/shared';

/**
 * Receivables and payables subledgers as of a date (ADR 0009, ADR 0010). Every item is signed so
 * that positive means "open": the customer owes us (A/R) or we owe the vendor (A/P).
 *
 *   A/R: invoice +open · credit memo −unused · payment −unapplied · other A/R postings debit−credit
 *   A/P: bill    +open · vendor credit −unused · bill payment −unapplied · other A/P postings credit−debit
 *
 * An application counts from its effective date = the later of the payment and document dates.
 * With that rule the open items sum to the control account's balance on every date (tested in
 * apps/api/test/ar-reports.test.ts and ap-reports.test.ts).
 */
export type LedgerSide = 'ar' | 'ap';

interface SideConfig {
  document: string;
  credit: string;
  payment: string;
  controlType: string;
  party: 'customer' | 'vendor';
  /** +1 when a debit to the control account increases the open balance (A/R). */
  debitSign: 1n | -1n;
}

export const SIDES: Record<LedgerSide, SideConfig> = {
  ar: {
    document: 'invoice',
    credit: 'credit_memo',
    payment: 'payment',
    controlType: 'accounts_receivable',
    party: 'customer',
    debitSign: 1n,
  },
  ap: {
    document: 'bill',
    credit: 'vendor_credit',
    payment: 'bill_payment',
    controlType: 'accounts_payable',
    party: 'vendor',
    debitSign: -1n,
  },
};

export interface LedgerItem {
  txnId: string;
  txnType: string;
  txnDate: string;
  number: string | null;
  partyId: string | null;
  partyName: string | null;
  dueDate: string | null;
  /** Original signed amount. */
  amount: Money;
  /** Signed open amount as of the date. */
  open: Money;
}

export async function openItems(
  tx: Tx,
  companyId: string,
  asOf: string,
  side: LedgerSide,
  partyId?: string,
): Promise<LedgerItem[]> {
  const c = SIDES[side];
  const partyCol = sql.ref(`t.${c.party}_id`);
  const partyTable = sql.table(c.party === 'customer' ? 'customers' : 'vendors');
  const byParty = partyId ? sql`and ${partyCol} = ${partyId}` : sql``;

  const docs = await sql<{
    id: string;
    txn_type: string;
    txn_date: string;
    txn_number: string | null;
    party_id: string | null;
    party_name: string | null;
    due_date: string | null;
    total: string;
    applied: string;
  }>`
    select t.id, t.txn_type, t.txn_date, t.txn_number, ${partyCol} as party_id,
           p.display_name as party_name, t.due_date, t.total,
           coalesce((
             select sum(pa.amount) from payment_applications pa
             join transactions pm on pm.id = pa.payment_id and pm.status = 'posted'
             where pa.target_id = t.id and greatest(pm.txn_date, t.txn_date) <= ${asOf}
           ), 0) as applied
    from transactions t
    left join ${partyTable} p on p.id = ${partyCol}
    where t.company_id = ${companyId} and t.status = 'posted' and t.txn_date <= ${asOf}
      and t.txn_type in (${c.document}, ${c.credit}) ${byParty}`.execute(tx);

  const payments = await sql<{
    id: string;
    txn_date: string;
    txn_number: string | null;
    party_id: string | null;
    party_name: string | null;
    total: string;
    net_applied: string;
  }>`
    select t.id, t.txn_date, t.txn_number, ${partyCol} as party_id, p.display_name as party_name,
           t.total,
           coalesce((
             select sum(case when tt.txn_type = ${c.document} then pa.amount else -pa.amount end)
             from payment_applications pa
             join transactions tt on tt.id = pa.target_id and tt.status = 'posted'
             where pa.payment_id = t.id and greatest(t.txn_date, tt.txn_date) <= ${asOf}
           ), 0) as net_applied
    from transactions t
    left join ${partyTable} p on p.id = ${partyCol}
    where t.company_id = ${companyId} and t.status = 'posted' and t.txn_date <= ${asOf}
      and t.txn_type = ${c.payment} ${byParty}`.execute(tx);

  const lineParty = sql.ref(`l.${c.party}_id`);
  const other = await sql<{
    id: string;
    txn_type: string;
    txn_date: string;
    txn_number: string | null;
    party_id: string | null;
    party_name: string | null;
    net: string;
  }>`
    select t.id, t.txn_type, t.txn_date, t.txn_number, ${lineParty} as party_id,
           p.display_name as party_name, sum(l.debit - l.credit) as net
    from journal_lines l
    join transactions t on t.id = l.transaction_id and t.version = l.version
    join accounts a on a.id = l.account_id and a.account_type = ${c.controlType}
    left join ${partyTable} p on p.id = ${lineParty}
    where l.company_id = ${companyId} and t.status = 'posted' and l.txn_date <= ${asOf}
      and t.txn_type not in (${c.document}, ${c.credit}, ${c.payment})
      ${partyId ? sql`and ${lineParty} = ${partyId}` : sql``}
    group by t.id, t.txn_type, t.txn_date, t.txn_number, ${lineParty}, p.display_name
    having sum(l.debit - l.credit) <> 0`.execute(tx);

  const items: LedgerItem[] = [];
  for (const d of docs.rows) {
    const total = parseMoney(d.total);
    const sign = d.txn_type === c.document ? 1n : -1n;
    items.push({
      txnId: d.id,
      txnType: d.txn_type,
      txnDate: d.txn_date,
      number: d.txn_number,
      partyId: d.party_id,
      partyName: d.party_name,
      dueDate: d.txn_type === c.document ? d.due_date : null,
      amount: sign * total,
      open: sign * (total - parseMoney(d.applied)),
    });
  }
  for (const p of payments.rows) {
    items.push({
      txnId: p.id,
      txnType: c.payment,
      txnDate: p.txn_date,
      number: p.txn_number,
      partyId: p.party_id,
      partyName: p.party_name,
      dueDate: null,
      amount: -parseMoney(p.total),
      open: -(parseMoney(p.total) - parseMoney(p.net_applied)),
    });
  }
  for (const o of other.rows) {
    const net = c.debitSign * parseMoney(o.net);
    items.push({
      txnId: o.id,
      txnType: o.txn_type,
      txnDate: o.txn_date,
      number: o.txn_number,
      partyId: o.party_id,
      partyName: o.party_name,
      dueDate: null,
      amount: net,
      open: net,
    });
  }
  return items.sort((a, b) => a.txnDate.localeCompare(b.txnDate) || a.txnId.localeCompare(b.txnId));
}

/** Open balance, overdue amount and available credit per party, as of `asOf`. */
export function balancesOf(
  items: LedgerItem[],
  today: string,
): Map<string, { open: Money; overdue: Money; credit: Money }> {
  const by = new Map<string, { open: Money; overdue: Money; credit: Money }>();
  for (const i of items) {
    if (!i.partyId || i.open === 0n) continue;
    const b = by.get(i.partyId) ?? { open: 0n, overdue: 0n, credit: 0n };
    b.open += i.open;
    if (i.open > 0n && i.dueDate && i.dueDate < today) b.overdue += i.open;
    if (i.open < 0n) b.credit += -i.open;
    by.set(i.partyId, b);
  }
  return by;
}

export type AgingBucket = 'current' | 'days1to30' | 'days31to60' | 'days61to90' | 'over90';
export const AGING_BUCKETS: AgingBucket[] = [
  'current',
  'days1to30',
  'days31to60',
  'days61to90',
  'over90',
];
export const AGING_LABELS: Record<AgingBucket, string> = {
  current: 'Current',
  days1to30: '1 - 30',
  days31to60: '31 - 60',
  days61to90: '61 - 90',
  over90: '91 and over',
};

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Days past due as of `asOf` (documents by due date, everything else by transaction date). */
export function daysPastDue(item: LedgerItem, asOf: string): number {
  return daysBetween(item.dueDate ?? item.txnDate, asOf);
}

export function bucketOf(item: LedgerItem, asOf: string): AgingBucket {
  const d = daysPastDue(item, asOf);
  if (d <= 0) return 'current';
  if (d <= 30) return 'days1to30';
  if (d <= 60) return 'days31to60';
  if (d <= 90) return 'days61to90';
  return 'over90';
}

export function agingOf(
  items: LedgerItem[],
  asOf: string,
): Record<AgingBucket, Money> & { total: Money } {
  const out = { current: 0n, days1to30: 0n, days31to60: 0n, days61to90: 0n, over90: 0n, total: 0n };
  for (const i of items) {
    if (i.open === 0n) continue;
    out[bucketOf(i, asOf)] += i.open;
    out.total += i.open;
  }
  return out;
}

export function agingDto(a: Record<AgingBucket, Money> & { total: Money }): AgingBuckets {
  return {
    current: moneyToString(a.current),
    days1to30: moneyToString(a.days1to30),
    days31to60: moneyToString(a.days31to60),
    days61to90: moneyToString(a.days61to90),
    over90: moneyToString(a.over90),
    total: moneyToString(a.total),
  };
}
