import type { SourceReport } from '@acct/shared';
import { parseUsDate, parseAmount, addDecimals, negate } from '../names';

/**
 * QuickBooks Desktop reports as the agent sends them: the qbXML `ReportRet` element converted to
 * JSON (attributes become properties; repeated elements become arrays, single ones objects).
 *
 *   <ColDesc colID="2"><ColTitle titleRow="1" value="Debit"/><ColType>Amount</ColType></ColDesc>
 *   <DataRow rowNumber="1"><RowData rowType="account" value="Utilities:Gas"/>
 *     <ColData colID="1" value="Gas"/><ColData colID="2" value="120.00"/></DataRow>
 */
type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : v ? [v as Obj] : []);
const text = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : typeof v === 'number'
      ? String(v)
      : String(o(v)['#text'] ?? o(v).value ?? '');

interface Column {
  id: string;
  title: string;
  type: string;
}

function columns(report: Obj): Column[] {
  return arr(report.ColDesc).map((c) => ({
    id: String(c.colID ?? ''),
    title: arr(c.ColTitle)
      .map((t) => String(t.value ?? ''))
      .filter(Boolean)
      .join(' ')
      .trim(),
    type: text(c.ColType),
  }));
}

interface Row {
  label: string | null;
  cells: Map<string, string>;
}

function rows(report: Obj): Row[] {
  const data = o(report.ReportData);
  return arr(data.DataRow).map((r) => ({
    label: o(r.RowData).value ? String(o(r.RowData).value) : null,
    cells: new Map(arr(r.ColData).map((c) => [String(c.colID ?? ''), String(c.value ?? '')])),
  }));
}

/** "10100 · Checking" (account numbers on) → "Checking", keeping "Parent:Child". */
function accountName(v: string): string {
  return v
    .split(':')
    .map((p) => p.replace(/^[A-Za-z0-9.-]+\s+·\s+/, '').trim())
    .join(':');
}

export function parseDesktopTrialBalance(report: Obj, asOf: string): SourceReport {
  const cols = columns(report);
  const debit = cols.find((c) => /debit/i.test(c.title))?.id ?? '2';
  const credit = cols.find((c) => /credit/i.test(c.title))?.id ?? '3';
  const label = cols.find((c) => c.type === 'Label')?.id ?? cols[0]?.id ?? '1';
  const out: SourceReport['rows'] = [];
  for (const r of rows(report)) {
    const name = accountName(r.label ?? r.cells.get(label) ?? '');
    if (!name || /^total/i.test(name)) continue;
    const d = parseAmount(r.cells.get(debit));
    const c = parseAmount(r.cells.get(credit));
    const amount = addDecimals(d, c ? negate(c) : null);
    if (amount !== '0') out.push({ ref: null, name, amount });
  }
  return { kind: 'trial_balance', asOf, rows: out };
}

export function parseDesktopAging(
  report: Obj,
  kind: 'ar_aging' | 'ap_aging',
  asOf: string,
): SourceReport {
  const cols = columns(report);
  const total = cols.find((c) => /^total$/i.test(c.title))?.id ?? cols.at(-1)?.id ?? '';
  const label = cols.find((c) => c.type === 'Label')?.id ?? cols[0]?.id ?? '1';
  const out: SourceReport['rows'] = [];
  for (const r of rows(report)) {
    const name = r.label ?? r.cells.get(label) ?? '';
    if (!name || /^total/i.test(name)) continue;
    const amount = parseAmount(r.cells.get(total));
    if (amount && amount !== '0') out.push({ ref: null, name, amount });
  }
  return { kind, asOf, rows: out };
}

export interface JournalTxn {
  txnId: string;
  txnType: string;
  date: string;
  number: string | null;
  lines: Array<{ account: string; amount: string; name: string | null; memo: string | null }>;
}

/**
 * The Journal detail report: every transaction's GL lines. A transaction's id, type, date and
 * number may be printed on its first line only, so they are carried down.
 */
export function parseDesktopJournal(report: Obj): JournalTxn[] {
  const cols = columns(report);
  const find = (type: string, title: RegExp) =>
    cols.find((c) => c.type === type)?.id ?? cols.find((c) => title.test(c.title))?.id;
  const id = find('TxnID', /^trans ?(id|#)/i);
  const type = find('TxnType', /^type$/i);
  const date = find('Date', /^date$/i);
  const num = find('RefNumber', /^num$/i);
  const name = find('Name', /^name$/i);
  const memo = find('Memo', /^memo$/i);
  const account = find('Account', /^account$/i);
  const debit = find('Debit', /^debit$/i);
  const credit = find('Credit', /^credit$/i);
  if (!id || !account) return [];
  const out = new Map<string, JournalTxn>();
  let cur: { id: string; type: string; date: string | null; num: string | null } | null = null;
  for (const r of rows(report)) {
    const get = (c: string | undefined) => (c ? (r.cells.get(c) ?? '').trim() : '');
    if (get(id))
      cur = { id: get(id), type: get(type), date: parseUsDate(get(date)), num: get(num) || null };
    if (!cur?.date || !get(account)) continue;
    const d = parseAmount(get(debit));
    const c = parseAmount(get(credit));
    const amount = addDecimals(d, c ? negate(c) : null);
    if (amount === '0') continue;
    const t = out.get(cur.id) ?? {
      txnId: cur.id,
      txnType: cur.type,
      date: cur.date,
      number: cur.num,
      lines: [],
    };
    t.lines.push({
      account: accountName(get(account)),
      amount,
      name: get(name) || null,
      memo: get(memo) || null,
    });
    out.set(cur.id, t);
  }
  return [...out.values()];
}
