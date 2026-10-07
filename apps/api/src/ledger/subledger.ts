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
 *
 * Foreign-currency items (ADR 0020): `amount` and `open` are always US dollars, as in the books:
 * a document's home_total less the US dollar value of what was applied to it (home_amount, at
 * the document's rate); a payment's control-account lines less the value of its applications.
 * The amounts in the party's currency are in `foreignAmount` and `foreignOpen`. Revaluations
 * and other control-account postings change only the US dollar value.
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
  /** Original signed amount, in US dollars. */
  amount: Money;
  /** Signed open amount as of the date, in US dollars. */
  open: Money;
  /** The party's currency; null for US dollars. */
  currency: string | null;
  /** Foreign-currency items: the signed amounts in the currency. */
  foreignAmount: Money | null;
  foreignOpen: Money | null;
}

export async function openItems(
  tx: Tx,
  companyId: string,
  asOf: string,
  side: LedgerSide,
  partyId?: string,
  opts: { openOnly?: boolean } = {},
): Promise<LedgerItem[]> {
  const c = SIDES[side];
  const partyCol = sql.ref(`t.${c.party}_id`);
  const partyTable = sql.table(c.party === 'customer' ? 'customers' : 'vendors');
  const byParty = partyId ? sql`and ${partyCol} = ${partyId}` : sql``;
  // Reports and balances want only what is still open: a busy company has tens of thousands of
  // settled documents, and leaving them in the database saves sending and parsing them (ADR 0028).
  const docsOpen = opts.openOnly
    ? sql`and (t.total <> coalesce(ap.applied, 0)
               or coalesce(t.home_total, t.total) <> coalesce(ap.applied_home, 0))`
    : sql``;
  const paymentsOpen = opts.openOnly
    ? sql`and (t.total <> coalesce(ap.net_applied, 0) or t.currency is not null)`
    : sql``;

  const docs = await sql<{
    id: string;
    txn_type: string;
    txn_date: string;
    txn_number: string | null;
    party_id: string | null;
    party_name: string | null;
    due_date: string | null;
    total: string;
    currency: string | null;
    home_total: string | null;
    applied: string;
    applied_home: string;
  }>`
    select t.id, t.txn_type, t.txn_date, t.txn_number, ${partyCol} as party_id,
           p.display_name as party_name, t.due_date, t.total, t.currency, t.home_total,
           coalesce(ap.applied, 0) as applied, coalesce(ap.applied_home, 0) as applied_home
    from transactions t
    left join lateral (
      select sum(pa.amount) as applied, sum(coalesce(pa.home_amount, pa.amount)) as applied_home
      from payment_applications pa
      join transactions pm on pm.id = pa.payment_id and pm.status = 'posted'
      where pa.target_id = t.id and greatest(pm.txn_date, t.txn_date) <= ${asOf}
    ) ap on true
    left join ${partyTable} p on p.id = ${partyCol}
    where t.company_id = ${companyId} and t.status = 'posted' and t.txn_date <= ${asOf}
      and t.txn_type in (${c.document}, ${c.credit}) ${byParty} ${docsOpen}`.execute(tx);

  const payments = await sql<{
    id: string;
    txn_date: string;
    txn_number: string | null;
    party_id: string | null;
    party_name: string | null;
    total: string;
    currency: string | null;
    control: string | null;
    net_applied: string;
    net_applied_home: string;
  }>`
    select t.id, t.txn_date, t.txn_number, ${partyCol} as party_id, p.display_name as party_name,
           t.total, t.currency,
           -- Foreign payments: what the payment took off the control account, in US dollars.
           case when t.currency is not null then (
             select ${c.debitSign === 1n ? sql`sum(l.credit - l.debit)` : sql`sum(l.debit - l.credit)`}
             from journal_lines l
             join accounts a on a.id = l.account_id and a.account_type = ${c.controlType}
             where l.transaction_id = t.id and l.version = t.version
           ) end as control,
           coalesce(ap.net_applied, 0) as net_applied,
           coalesce(ap.net_applied_home, 0) as net_applied_home
    from transactions t
    left join lateral (
      select sum(case when tt.txn_type = ${c.document} then pa.amount else -pa.amount end)
               as net_applied,
             sum(case when tt.txn_type = ${c.document} then 1 else -1 end
                 * coalesce(pa.home_amount, pa.amount)) as net_applied_home
      from payment_applications pa
      join transactions tt on tt.id = pa.target_id and tt.status = 'posted'
      where pa.payment_id = t.id and greatest(t.txn_date, tt.txn_date) <= ${asOf}
    ) ap on true
    left join ${partyTable} p on p.id = ${partyCol}
    where t.company_id = ${companyId} and t.status = 'posted' and t.txn_date <= ${asOf}
      and t.txn_type = ${c.payment} ${byParty} ${paymentsOpen}`.execute(tx);

  // The control accounts first: with their ids the planner knows how many lines they hold, and
  // hashes the transactions instead of looking each line's transaction up (ADR 0028).
  const control = (
    await tx
      .selectFrom('accounts')
      .select('id')
      .where('company_id', '=', companyId)
      .where('account_type', '=', c.controlType)
      .execute()
  ).map((a) => a.id);
  const lineParty = sql.ref(`l.${c.party}_id`);
  const other = await sql<{
    id: string;
    txn_type: string;
    txn_date: string;
    txn_number: string | null;
    party_id: string | null;
    party_name: string | null;
    currency: string | null;
    net: string;
  }>`
    select t.id, t.txn_type, t.txn_date, t.txn_number, ${lineParty} as party_id,
           p.display_name as party_name, a.currency, sum(l.debit - l.credit) as net
    from journal_lines l
    join transactions t on t.id = l.transaction_id and t.version = l.version
    join accounts a on a.id = l.account_id
    left join ${partyTable} p on p.id = ${lineParty}
    where l.company_id = ${companyId} and t.status = 'posted' and l.txn_date <= ${asOf}
      and l.account_id in (${control.length ? sql.join(control) : sql`null`})
      and t.txn_type not in (${c.document}, ${c.credit}, ${c.payment})
      ${partyId ? sql`and ${lineParty} = ${partyId}` : sql``}
    group by t.id, t.txn_type, t.txn_date, t.txn_number, ${lineParty}, p.display_name, a.currency
    having sum(l.debit - l.credit) <> 0`.execute(tx);

  const items: LedgerItem[] = [];
  for (const d of docs.rows) {
    const total = parseMoney(d.total);
    const sign = d.txn_type === c.document ? 1n : -1n;
    const foreign = d.currency !== null;
    const home = foreign ? parseMoney(d.home_total ?? '0') : total;
    items.push({
      txnId: d.id,
      txnType: d.txn_type,
      txnDate: d.txn_date,
      number: d.txn_number,
      partyId: d.party_id,
      partyName: d.party_name,
      dueDate: d.txn_type === c.document ? d.due_date : null,
      amount: sign * home,
      open: sign * (home - parseMoney(foreign ? d.applied_home : d.applied)),
      currency: d.currency,
      foreignAmount: foreign ? sign * total : null,
      foreignOpen: foreign ? sign * (total - parseMoney(d.applied)) : null,
    });
  }
  for (const p of payments.rows) {
    const total = parseMoney(p.total);
    const foreign = p.currency !== null;
    const home = foreign ? parseMoney(p.control ?? '0') : total;
    items.push({
      txnId: p.id,
      txnType: c.payment,
      txnDate: p.txn_date,
      number: p.txn_number,
      partyId: p.party_id,
      partyName: p.party_name,
      dueDate: null,
      amount: -home,
      open: -(home - parseMoney(foreign ? p.net_applied_home : p.net_applied)),
      currency: p.currency,
      foreignAmount: foreign ? -total : null,
      foreignOpen: foreign ? -(total - parseMoney(p.net_applied)) : null,
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
      // Revaluations and other postings to a foreign-currency account change only its US dollar
      // value.
      currency: o.currency,
      foreignAmount: o.currency ? 0n : null,
      foreignOpen: o.currency ? 0n : null,
    });
  }
  return items.sort((a, b) => a.txnDate.localeCompare(b.txnDate) || a.txnId.localeCompare(b.txnId));
}

export interface PartyBalance {
  /** In the party's currency. */
  open: Money;
  overdue: Money;
  credit: Money;
  /** The open balance's US dollar value in the books. */
  homeOpen: Money;
  currency: string | null;
}

/**
 * Open balance, overdue amount and available credit per party, as of `asOf`, in the party's
 * currency (a party's items all share its currency), with the US dollar value of the balance.
 */
export function balancesOf(items: LedgerItem[], today: string): Map<string, PartyBalance> {
  const by = new Map<string, PartyBalance>();
  for (const i of items) {
    const open = i.foreignOpen ?? i.open;
    if (!i.partyId || (open === 0n && i.open === 0n)) continue;
    const b = by.get(i.partyId) ?? {
      open: 0n,
      overdue: 0n,
      credit: 0n,
      homeOpen: 0n,
      currency: i.currency,
    };
    b.open += open;
    b.homeOpen += i.open;
    if (open > 0n && i.dueDate && i.dueDate < today) b.overdue += open;
    if (open < 0n) b.credit += -open;
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
