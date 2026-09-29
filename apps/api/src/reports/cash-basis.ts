import { sql, type Tx } from '@acct/db';
import { parseMoney, type Money } from '@acct/shared';

/**
 * Cash-basis conversion (ADR 0009).
 *
 * On the accrual ledger an invoice debits A/R and credits income when it is issued. On a cash
 * basis the income belongs to the day the customer pays. The conversion is done at report time,
 * never stored:
 *
 *   1. Invoice and credit-memo journal lines are left out entirely.
 *   2. Every other posting (payments, receipts, deposits, journal entries…) counts as-is. A
 *      payment still debits Undeposited Funds/bank and credits A/R.
 *   3. Each application of a payment to an invoice, on its effective date (the later of the
 *      payment and invoice dates), recognises that share of the invoice: debit A/R by the amount
 *      applied and credit each invoice line in proportion. Credit memos applied work the same way
 *      with the signs reversed.
 *
 * So a fully paid invoice leaves A/R at zero and its income on the payment date; an unpaid one
 * leaves nothing; an overpayment shows as a credit balance in A/R. Shares are allocated on the
 * cumulative amount applied, so once a document is fully applied every line is recognised
 * exactly, with no rounding drift.
 */

/**
 * Splits `portion` of `total` across `values` (signed, summing to `total`) in proportion, rounding
 * each share to the cent and giving the rounding remainder to the largest line, so the shares
 * sum to `portion` exactly. When portion = total the values come back unchanged.
 */
export function allocate(values: Money[], total: Money, portion: Money): Money[] {
  if (portion === total) return [...values];
  if (total === 0n || values.length === 0) return values.map(() => 0n);
  const CENT = 100n; // money is in 1/10,000; round shares to 1/100
  const shares = values.map((v) => {
    const exact = v * portion; // scaled by total
    const q = exact / (total * CENT);
    const r = exact % (total * CENT);
    // Round half away from zero.
    const twice = (r < 0n ? -r : r) * 2n;
    const bump =
      twice >= (total < 0n ? -total : total) * CENT ? (exact < 0n !== total < 0n ? -1n : 1n) : 0n;
    return (q + bump) * CENT;
  });
  const diff = portion - shares.reduce((s, v) => s + v, 0n);
  if (diff !== 0n) {
    let largest = 0;
    values.forEach((v, i) => {
      const abs = v < 0n ? -v : v;
      const best = values[largest]! < 0n ? -values[largest]! : values[largest]!;
      if (abs > best) largest = i;
    });
    shares[largest] = shares[largest]! + diff;
  }
  return shares;
}

export interface CashFilter {
  from?: string | null;
  to: string;
  classId?: string;
  locationId?: string;
}

interface Application {
  target_id: string;
  payment_id: string;
  amount: string;
  eff_date: string;
  total: string;
  txn_type: string;
}

interface TargetLine {
  transaction_id: string;
  account_id: string;
  net: string;
  class_id: string | null;
  location_id: string | null;
  is_ar: boolean;
}

/** Recognised amounts from invoice/credit-memo applications, as net debit − credit per account. */
export async function cashRecognition(
  tx: Tx,
  companyId: string,
  f: CashFilter,
): Promise<Map<string, Money>> {
  // Every application up to `to` is needed, even before `from`, to allocate cumulatively.
  const apps = await sql<Application>`
    select pa.target_id, pa.payment_id, pa.amount, greatest(p.txn_date, t.txn_date) as eff_date,
           t.total, t.txn_type
    from payment_applications pa
    join transactions p on p.id = pa.payment_id and p.status = 'posted'
    join transactions t on t.id = pa.target_id and t.status = 'posted'
    where pa.company_id = ${companyId} and greatest(p.txn_date, t.txn_date) <= ${f.to}
    order by pa.target_id, eff_date, p.txn_date, pa.payment_id`.execute(tx);
  const out = new Map<string, Money>();
  if (apps.rows.length === 0) return out;

  const targetIds = [...new Set(apps.rows.map((a) => a.target_id))];
  const lines = await sql<TargetLine>`
    select l.transaction_id, l.account_id, (l.debit - l.credit) as net, l.class_id, l.location_id,
           a.account_type = 'accounts_receivable' as is_ar
    from journal_lines l
    join transactions t on t.id = l.transaction_id and t.version = l.version
    join accounts a on a.id = l.account_id
    where l.transaction_id in (${sql.join(targetIds)})
    order by l.transaction_id, l.line_no`.execute(tx);
  const byTarget = new Map<string, TargetLine[]>();
  for (const l of lines.rows) {
    const list = byTarget.get(l.transaction_id) ?? [];
    list.push(l);
    byTarget.set(l.transaction_id, list);
  }

  const matches = (l: { class_id: string | null; location_id: string | null }) =>
    (!f.classId || l.class_id === f.classId) && (!f.locationId || l.location_id === f.locationId);
  const add = (accountId: string, v: Money) => {
    if (v !== 0n) out.set(accountId, (out.get(accountId) ?? 0n) + v);
  };

  let i = 0;
  while (i < apps.rows.length) {
    const targetId = apps.rows[i]!.target_id;
    const tLines = byTarget.get(targetId) ?? [];
    const arLines = tLines.filter((l) => l.is_ar);
    const other = tLines.filter((l) => !l.is_ar);
    const values = other.map((l) => parseMoney(l.net));
    // Signed total of the non-A/R side: −total for an invoice (credits), +total for a credit memo.
    const sideTotal = values.reduce((s, v) => s + v, 0n);
    const sign = apps.rows[i]!.txn_type === 'invoice' ? -1n : 1n;
    let cumulative = 0n;
    let previous = values.map(() => 0n);
    for (; i < apps.rows.length && apps.rows[i]!.target_id === targetId; i++) {
      const a = apps.rows[i]!;
      cumulative += parseMoney(a.amount);
      const current = allocate(values, sideTotal, sign * cumulative);
      if (!f.from || a.eff_date >= f.from) {
        other.forEach((l, k) => {
          if (matches(l)) add(l.account_id, current[k]! - previous[k]!);
        });
        const arLine = arLines[0];
        if (arLine && matches(arLine)) add(arLine.account_id, -sign * parseMoney(a.amount));
      }
      previous = current;
    }
  }
  return out;
}
