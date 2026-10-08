import type { SourceReport } from '@acct/shared';
import { addDecimals, negate, parseAmount } from '../names';

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);

/** Every data row of a QBO report (sections nest rows; summaries and headers are skipped). */
function dataRows(rows: unknown): Array<Array<{ value: string; id: string | null }>> {
  const out: Array<Array<{ value: string; id: string | null }>> = [];
  for (const row of arr(o(rows).Row)) {
    if (row.Rows) out.push(...dataRows(row.Rows));
    if (row.ColData && (row.type === undefined || row.type === 'Data'))
      out.push(
        arr(row.ColData).map((c) => ({
          value: String(c.value ?? ''),
          id: c.id ? String(c.id) : null,
        })),
      );
  }
  return out;
}

function columnIndex(report: Obj, title: RegExp): number {
  return arr(o(report.Columns).Column).findIndex((c) => title.test(String(c.ColTitle ?? '')));
}

/** TrialBalance → rows of debit − credit by account (id and full name). */
export function parseQboTrialBalance(report: Obj, asOf: string): SourceReport {
  const debit = Math.max(columnIndex(report, /^debit$/i), 1);
  const credit = Math.max(columnIndex(report, /^credit$/i), 2);
  const rows: SourceReport['rows'] = [];
  for (const cols of dataRows(report.Rows)) {
    const name = cols[0]?.value ?? '';
    if (!name || /^total$/i.test(name)) continue;
    const d = parseAmount(cols[debit]?.value);
    const c = parseAmount(cols[credit]?.value);
    const amount = addDecimals(d, c ? negate(c) : null);
    if (amount === '0') continue;
    rows.push({ ref: cols[0]?.id ?? null, name, amount });
  }
  return { kind: 'trial_balance', asOf, rows };
}

/** AgedReceivables / AgedPayables → open balance ("Total" column) by customer or vendor. */
export function parseQboAging(
  report: Obj,
  kind: 'ar_aging' | 'ap_aging',
  asOf: string,
): SourceReport {
  let total = columnIndex(report, /^total$/i);
  const rows: SourceReport['rows'] = [];
  for (const cols of dataRows(report.Rows)) {
    if (total < 0) total = cols.length - 1;
    const name = cols[0]?.value ?? '';
    if (!name || /^total$/i.test(name)) continue;
    const amount = parseAmount(cols[total]?.value);
    if (!amount || amount === '0') continue;
    rows.push({ ref: cols[0]?.id ?? null, name, amount });
  }
  return { kind, asOf, rows };
}
