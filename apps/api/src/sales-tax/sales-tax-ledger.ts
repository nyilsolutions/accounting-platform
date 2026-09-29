import { sql, type Tx } from '@acct/db';
import {
  addDays,
  addMonths,
  moneyToString,
  monthStartOf,
  parseMoney,
  type FilingFrequency,
  type Money,
} from '@acct/shared';

export interface SalesTaxLine {
  agencyId: string;
  taxRateId: string | null;
  rate: string | null;
  /** Signed like `amount`. */
  taxable: Money;
  /** + raises what is owed to the agency, - lowers it. */
  amount: Money;
}

/** Replaces a transaction's sales tax detail (document detail is current state, like sales_lines). */
export async function replaceSalesTaxLines(
  tx: Tx,
  companyId: string,
  transactionId: string,
  lines: SalesTaxLine[],
): Promise<void> {
  await tx.deleteFrom('sales_tax_lines').where('transaction_id', '=', transactionId).execute();
  if (lines.length === 0) return;
  await tx
    .insertInto('sales_tax_lines')
    .values(
      lines.map((l, i) => ({
        company_id: companyId,
        transaction_id: transactionId,
        line_no: i + 1,
        agency_id: l.agencyId,
        tax_rate_id: l.taxRateId,
        rate: l.rate,
        taxable_amount: moneyToString(l.taxable, 4),
        amount: moneyToString(l.amount, 4),
      })),
    )
    .execute();
}

/** What is owed to each agency from posted transactions dated in the range. */
export async function agencyBalances(
  tx: Tx,
  companyId: string,
  range: { from?: string; to: string },
): Promise<Map<string, Money>> {
  const rows = await sql<{ agency_id: string; amount: string }>`
    select stl.agency_id, sum(stl.amount) as amount
    from sales_tax_lines stl
    join transactions t on t.id = stl.transaction_id and t.status = 'posted'
    where stl.company_id = ${companyId} and t.txn_date <= ${range.to}
      ${range.from ? sql`and t.txn_date >= ${range.from}` : sql``}
    group by stl.agency_id`.execute(tx);
  return new Map(rows.rows.map((r) => [r.agency_id, parseMoney(r.amount)]));
}

/** The filing period (calendar month, quarter or year) containing `date`. */
export function filingPeriod(date: string, freq: FilingFrequency): { from: string; to: string } {
  const month = Number(date.slice(5, 7));
  const year = date.slice(0, 4);
  let from: string;
  let months: number;
  if (freq === 'monthly') {
    from = monthStartOf(date);
    months = 1;
  } else if (freq === 'quarterly') {
    const q = Math.floor((month - 1) / 3);
    from = `${year}-${String(q * 3 + 1).padStart(2, '0')}-01`;
    months = 3;
  } else {
    from = `${year}-01-01`;
    months = 12;
  }
  return { from, to: addDays(addMonths(from, months), -1) };
}

export function previousFilingPeriod(
  date: string,
  freq: FilingFrequency,
): { from: string; to: string } {
  return filingPeriod(addDays(filingPeriod(date, freq).from, -1), freq);
}
