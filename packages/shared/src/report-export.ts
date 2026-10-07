import { formatPeriod } from './dates';
import type { GeneralLedgerDto, ReportDto, ReportRowKind } from './reports';
import { TXN_TYPE_LABELS } from './sales';

/**
 * A report as a plain table, the one shape every export (CSV, Excel, PDF) is written from.
 * Amounts stay plain decimal strings ("-1234.50"), never formatted, so spreadsheets read them as
 * numbers.
 */
export interface ReportTable {
  title: string;
  companyName: string;
  period: string;
  basis: string;
  header: string[];
  /** Index of the first amount column. */
  amountStart: number;
  /** Absolute column indexes that hold percentages. */
  percentColumns: number[];
  rows: Array<{
    kind: ReportRowKind | 'account_header';
    depth: number;
    cells: Array<string | null>;
  }>;
  notes: string[];
}

export function reportToTable(report: ReportDto | GeneralLedgerDto): ReportTable {
  const base = {
    title: report.title,
    companyName: report.companyName,
    period: formatPeriod(report.from, report.to),
    basis: report.basis === 'cash' ? 'Cash basis' : 'Accrual basis',
  };
  if ('accounts' in report) {
    const header = [
      'Date',
      'Transaction type',
      'No.',
      'Name',
      'Memo/Description',
      'Split',
      'Debit',
      'Credit',
      'Balance',
    ];
    const rows: ReportTable['rows'] = [];
    for (const a of report.accounts) {
      rows.push({ kind: 'account_header', depth: 0, cells: [a.label] });
      if (report.beginningBalances)
        rows.push({
          kind: 'row',
          depth: 1,
          cells: [
            'Beginning balance',
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            a.beginningBalance,
          ],
        });
      for (const r of a.rows) {
        rows.push({
          kind: 'row',
          depth: 1,
          cells: [
            r.txnDate,
            TXN_TYPE_LABELS[r.txnType] ?? r.txnType,
            r.number,
            r.name,
            r.description,
            r.split,
            r.debit,
            r.credit,
            r.balance,
          ],
        });
      }
      rows.push({
        kind: 'total',
        depth: 0,
        cells: [
          `Total for ${a.label}`,
          null,
          null,
          null,
          null,
          null,
          a.totalDebit,
          a.totalCredit,
          a.endingBalance,
        ],
      });
    }
    return {
      ...base,
      header,
      amountStart: 6,
      percentColumns: [],
      rows,
      notes: report.truncated ? ['Limited to the first 20,000 lines.'] : [],
    };
  }
  const text = report.textColumns ?? [];
  const lead = text.length ? text.length : 1;
  const rows = report.rows.map((r) => ({
    kind: r.kind,
    depth: r.depth,
    cells: [
      ...(text.length && r.cells
        ? r.cells
        : [r.label, ...Array.from({ length: lead - 1 }, () => null)]),
      ...r.amounts,
    ],
  }));
  return {
    ...base,
    header: [...(text.length ? text : ['']), ...report.columns],
    amountStart: lead,
    percentColumns: (report.percentColumns ?? []).map((i) => i + lead),
    rows,
    notes: [
      ...(report.notes ?? []),
      ...(report.truncated ? ['Limited to the first 20,000 lines.'] : []),
    ],
  };
}

/** CSV (opens in Excel). Labels are indented with spaces; numbers are plain decimals. */
export function reportToCsv(report: ReportDto | GeneralLedgerDto): string {
  const t = reportToTable(report);
  const esc = (v: string | null | undefined) => {
    const s = v ?? '';
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines: Array<Array<string | null>> = [
    [safeCell(t.companyName)],
    [safeCell(t.title)],
    [safeCell(t.period)],
    [],
    t.header.map(safeCell),
  ];
  for (const r of t.rows) {
    // Neutralize formulas first, then indent (indenting first would hide a leading "=").
    const cells = r.cells.map(safeCell);
    if (cells[0] && r.depth > 0) cells[0] = `${'  '.repeat(r.depth)}${cells[0]}`;
    lines.push(cells);
  }
  for (const n of t.notes) lines.push([], [safeCell(n)]);
  return lines.map((l) => l.map((c) => esc(c)).join(',')).join('\r\n');
}

/**
 * Spreadsheets run text starting with = + - @ as formulas. Names and memos come from people, so
 * such text gets a leading apostrophe (numbers like "-12.50" stay numbers).
 */
export function safeCell(v: string | null | undefined): string {
  const s = v ?? '';
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}
