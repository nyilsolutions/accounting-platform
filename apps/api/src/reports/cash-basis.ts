import { sql, type Tx } from '@acct/db';
import { parseMoney, type Money } from '@acct/shared';

/**
 * Cash-basis conversion (ADR 0009, extended to payables in ADR 0010).
 *
 * On the accrual ledger an invoice debits A/R and credits income when it is issued, and a bill
 * debits expense and credits A/P when it is entered. On a cash basis the income or expense
 * belongs to the day the money moves. The conversion is done at report time, never stored:
 *
 *   1. Invoice, credit-memo, bill and vendor-credit journal lines are left out entirely.
 *   2. Every other posting (payments, bill payments, receipts, checks, expenses, deposits,
 *      journal entries…) counts as-is. A payment still credits A/R; a bill payment debits A/P.
 *   3. Each application of a payment to a document, on its effective date (the later of the
 *      payment and document dates), recognises that share of the document's lines and moves the
 *      same amount back through A/R or A/P. Credits applied work the same way, signs reversed.
 *
 * So a fully paid invoice or bill leaves A/R/A/P at zero and its income/expense on the payment
 * date; an unpaid one leaves nothing; an overpayment shows as a credit balance in A/R. Shares are
 * allocated on the cumulative amount applied, so once a document is fully applied every line is
 * recognised exactly, with no rounding drift.
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

/** Dimension filters take an id, or 'none' for lines without one. */
export interface CashFilter {
  from?: string | null;
  to: string;
  classId?: string;
  locationId?: string;
  customerId?: string;
  vendorId?: string;
}

interface Application {
  target_id: string;
  payment_id: string;
  amount: string;
  eff_date: string;
  txn_type: string;
}

interface TargetLine {
  transaction_id: string;
  account_id: string;
  net: string;
  class_id: string | null;
  location_id: string | null;
  customer_id: string | null;
  vendor_id: string | null;
  is_control: boolean;
}

/** One recognised amount: part of a document's line, recognised when a payment was applied. */
export interface Recognition {
  accountId: string;
  /** Net debit − credit. */
  amount: Money;
  date: string;
  targetId: string;
  targetType: string;
  paymentId: string;
  classId: string | null;
  locationId: string | null;
  customerId: string | null;
  vendorId: string | null;
}

/**
 * Recognitions from applications of payments to invoices, credit memos, bills and vendor credits
 * with an effective date in [from, to]. For each application of amount x the document's non-control
 * lines are recognised in proportion (cumulatively, see `allocate`) and the control account (A/R or
 * A/P) takes the opposite amount, which cancels the payment's own control-account posting.
 */
export async function recognitions(
  tx: Tx,
  companyId: string,
  f: { from?: string | null; to: string },
  opts: { targetTypes?: string[] } = {},
): Promise<Recognition[]> {
  // Every application up to `to` is needed, even before `from`, to allocate cumulatively.
  const apps = await sql<Application>`
    select pa.target_id, pa.payment_id,
           -- Foreign-currency documents: what the application is worth in US dollars at the
           -- document's rate (ADR 0020), so a settled document is recognised in full.
           coalesce(pa.home_amount, pa.amount) as amount,
           greatest(p.txn_date, t.txn_date) as eff_date,
           t.txn_type
    from payment_applications pa
    join transactions p on p.id = pa.payment_id and p.status = 'posted'
    join transactions t on t.id = pa.target_id and t.status = 'posted'
    where pa.company_id = ${companyId} and greatest(p.txn_date, t.txn_date) <= ${f.to}
      ${opts.targetTypes ? sql`and t.txn_type in (${sql.join(opts.targetTypes)})` : sql``}
    order by pa.target_id, eff_date, p.txn_date, pa.payment_id`.execute(tx);
  const out: Recognition[] = [];
  if (apps.rows.length === 0) return out;

  const targetIds = [...new Set(apps.rows.map((a) => a.target_id))];
  const lines = await sql<TargetLine>`
    select l.transaction_id, l.account_id, (l.debit - l.credit) as net, l.class_id, l.location_id,
           l.customer_id, l.vendor_id, a.account_type in ('accounts_receivable', 'accounts_payable') as is_control
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

  let i = 0;
  while (i < apps.rows.length) {
    const first = apps.rows[i]!;
    const tLines = byTarget.get(first.target_id) ?? [];
    const control = tLines.find((l) => l.is_control);
    const other = tLines.filter((l) => !l.is_control);
    const values = other.map((l) => parseMoney(l.net));
    // Signed total of the non-control side: negative for invoices and vendor credits (credits to
    // income/expense), positive for credit memos and bills.
    const sideTotal = values.reduce((s, v) => s + v, 0n);
    const sign = sideTotal < 0n ? -1n : 1n;
    let cumulative = 0n;
    let previous = values.map(() => 0n);
    for (; i < apps.rows.length && apps.rows[i]!.target_id === first.target_id; i++) {
      const a = apps.rows[i]!;
      cumulative += parseMoney(a.amount);
      const current = allocate(values, sideTotal, sign * cumulative);
      if (!f.from || a.eff_date >= f.from) {
        const base = {
          date: a.eff_date,
          targetId: a.target_id,
          targetType: a.txn_type,
          paymentId: a.payment_id,
        };
        other.forEach((l, k) => {
          const v = current[k]! - previous[k]!;
          if (v !== 0n)
            out.push({
              ...base,
              accountId: l.account_id,
              amount: v,
              classId: l.class_id,
              locationId: l.location_id,
              customerId: l.customer_id,
              vendorId: l.vendor_id,
            });
        });
        if (control) {
          out.push({
            ...base,
            accountId: control.account_id,
            amount: -sign * parseMoney(a.amount),
            classId: control.class_id,
            locationId: control.location_id,
            customerId: control.customer_id,
            vendorId: control.vendor_id,
          });
        }
      }
      previous = current;
    }
  }
  return out;
}

/** Recognised amounts as net debit − credit per account (cash-basis reports). */
export async function cashRecognition(
  tx: Tx,
  companyId: string,
  f: CashFilter,
): Promise<Map<string, Money>> {
  const out = new Map<string, Money>();
  const matches = (want: string | undefined, have: string | null) =>
    !want || (want === 'none' ? have === null : have === want);
  for (const r of await recognitions(tx, companyId, f)) {
    if (!matches(f.classId, r.classId)) continue;
    if (!matches(f.locationId, r.locationId)) continue;
    if (!matches(f.customerId, r.customerId)) continue;
    if (!matches(f.vendorId, r.vendorId)) continue;
    out.set(r.accountId, (out.get(r.accountId) ?? 0n) + r.amount);
  }
  return out;
}

/**
 * Document types whose postings are replaced by recognitions on the cash basis. Currency
 * revaluations (unrealized gains and losses on open balances) have no place on a cash basis.
 */
export const ACCRUAL_ONLY_TYPES = [
  'invoice',
  'credit_memo',
  'bill',
  'vendor_credit',
  'currency_revaluation',
] as const;
