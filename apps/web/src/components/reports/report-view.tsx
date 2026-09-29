'use client';

import Link from 'next/link';
import {
  formatDate,
  formatMoney,
  formatPeriod,
  type GeneralLedgerDto,
  type ReportDto,
  type ReportRow,
  TXN_TYPE_LABELS,
} from '@acct/shared';
import { cx } from '@/components/ui';

function Amount({ value, percent }: { value: string | null | undefined; percent?: boolean }) {
  if (value === null || value === undefined) return null;
  return <>{percent ? `${formatMoney(value)}%` : formatMoney(value)}</>;
}

function ReportHeader({
  companyName,
  title,
  from,
  to,
  basis,
}: {
  companyName: string;
  title: string;
  from: string | null;
  to: string;
  basis: string;
}) {
  return (
    <div className="mb-6 text-center">
      <div className="text-sm text-gray-600">{companyName}</div>
      <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
      <div className="text-sm text-gray-600">{formatPeriod(from, to)}</div>
      <div className="mt-1 text-xs text-gray-400 print:hidden">
        {basis === 'accrual' ? 'Accrual basis' : 'Cash basis'}
      </div>
    </div>
  );
}

function Notes({ notes, truncated }: { notes?: string[]; truncated?: boolean }) {
  if (!notes?.length && !truncated) return null;
  return (
    <div className="mt-4 space-y-1 text-center text-xs text-gray-500" data-testid="report-notes">
      {truncated && (
        <p className="rounded bg-amber-50 p-2 text-amber-800">
          This report is limited to the first 20,000 lines. Narrow the dates or filter it.
        </p>
      )}
      {notes?.map((n) => (
        <p key={n}>{n}</p>
      ))}
    </div>
  );
}

/**
 * Statement-style report (P&L, balance sheet, trial balance, A/R summaries, budgets…). Amounts
 * drill down: an account's amount in a column opens the transactions behind it for that column's
 * period and filters; customers and vendors open their pages; detail rows open the transaction.
 * Reports with `textColumns` are tabular: each row's `cells` come before the amounts.
 */
export function StatementView({
  report,
  drillHref,
}: {
  report: ReportDto;
  /** Where a row's amount in column `col` leads (null: not a link). */
  drillHref: (row: ReportRow, col: number) => string | null;
}) {
  const text = report.textColumns ?? [];
  const wide = text.length > 0 || report.columns.length > 3;
  const percent = new Set(report.percentColumns ?? []);
  return (
    <div className={cx('mx-auto', wide ? 'max-w-full overflow-x-auto' : 'max-w-3xl')}>
      <ReportHeader
        companyName={report.companyName}
        title={report.title}
        from={report.from}
        to={report.to}
        basis={report.basis}
      />
      <table className="w-full text-sm" data-testid="report-table">
        <thead>
          <tr className="border-b border-gray-300 text-left text-xs uppercase tracking-wide text-gray-500">
            {text.length ? (
              text.map((c) => (
                <th key={c} className="whitespace-nowrap px-2 py-1">
                  {c}
                </th>
              ))
            ) : (
              <th />
            )}
            {report.columns.map((c) => (
              <th key={c} className="min-w-28 px-2 py-1 text-right">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row, i) => {
            const drillable = row.accountId || row.customerId || row.vendorId || row.txnId;
            const canDrill = drillable && row.kind !== 'section';
            const tabular = text.length > 0 && row.cells;
            const firstHref = canDrill ? drillHref(row, 0) : null;
            return (
              <tr
                key={i}
                className={cx(
                  row.kind === 'section' && 'font-semibold',
                  row.kind === 'total' && 'font-semibold',
                  row.kind === 'calculated' && 'border-t border-gray-300 font-semibold',
                  row.kind === 'grand_total' &&
                    'border-t-2 border-b-4 border-double border-gray-800 font-bold',
                )}
              >
                {tabular ? (
                  row.cells!.map((c, j) => (
                    <td
                      key={j}
                      className={cx('whitespace-nowrap px-2 py-1', j === 0 && 'pl-6')}
                      style={j === 0 ? { paddingLeft: `${row.depth * 1.25 + 0.5}rem` } : undefined}
                    >
                      {j === 0 && firstHref && c ? (
                        <Link
                          href={firstHref}
                          className="text-brand-700 hover:underline print:text-inherit"
                        >
                          {/^\d{4}-\d{2}-\d{2}$/.test(c) ? formatDate(c) : c}
                        </Link>
                      ) : c && /^\d{4}-\d{2}-\d{2}$/.test(c) ? (
                        formatDate(c)
                      ) : (
                        c
                      )}
                    </td>
                  ))
                ) : (
                  <td
                    className="py-1 pr-2"
                    colSpan={Math.max(text.length, 1)}
                    style={{ paddingLeft: `${row.depth * 1.25 + 0.25}rem` }}
                  >
                    {row.label}
                  </td>
                )}
                {row.amounts.map((a, j) => {
                  const href = canDrill && a !== null ? drillHref(row, j) : null;
                  return (
                    <td
                      key={j}
                      className={cx(
                        'whitespace-nowrap px-2 py-1 text-right tabular-nums',
                        row.kind === 'total' && a !== null && 'border-t border-gray-300',
                      )}
                    >
                      {href ? (
                        <Link
                          href={href}
                          className="text-brand-700 hover:underline print:text-inherit"
                        >
                          <Amount value={a} percent={percent.has(j)} />
                        </Link>
                      ) : (
                        <Amount value={a} percent={percent.has(j)} />
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <Notes notes={report.notes} truncated={report.truncated} />
      <p className="mt-6 text-center text-xs text-gray-400">
        Generated {new Date(report.generatedAt).toLocaleString()}
      </p>
    </div>
  );
}

const TXN_LABELS = TXN_TYPE_LABELS;

/** General Ledger, P&L Detail, Balance Sheet Detail, Transaction Detail by Account. */
export function LedgerView({
  report,
  txnHref,
}: {
  report: GeneralLedgerDto;
  txnHref: (txnType: string, id: string) => string;
}) {
  return (
    <div>
      <ReportHeader
        companyName={report.companyName}
        title={report.title}
        from={report.from}
        to={report.to}
        basis={report.basis}
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-sm" data-testid="report-table">
          <thead>
            <tr className="border-b border-gray-300 text-left text-xs uppercase tracking-wide text-gray-500">
              <th className="px-2 py-1">Date</th>
              <th className="px-2 py-1">Type</th>
              <th className="px-2 py-1">No.</th>
              <th className="px-2 py-1">Name</th>
              <th className="px-2 py-1">Memo/Description</th>
              <th className="px-2 py-1">Split</th>
              <th className="px-2 py-1 text-right">Debit</th>
              <th className="px-2 py-1 text-right">Credit</th>
              <th className="px-2 py-1 text-right">Balance</th>
            </tr>
          </thead>
          {report.accounts.map((acc) => (
            <tbody key={acc.accountId}>
              <tr className="font-semibold">
                <td colSpan={9} className="px-2 pt-4 pb-1">
                  {acc.label}
                </td>
              </tr>
              {report.beginningBalances && (
                <tr className="text-gray-600">
                  <td colSpan={8} className="px-2 py-1 pl-6">
                    Beginning balance
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    <Amount value={acc.beginningBalance} />
                  </td>
                </tr>
              )}
              {acc.rows.map((r, i) => (
                <tr key={`${r.transactionId}-${i}`} className="hover:bg-gray-50">
                  <td className="whitespace-nowrap px-2 py-1 pl-6">
                    <Link
                      href={txnHref(r.txnType, r.transactionId)}
                      className="text-brand-700 hover:underline print:text-inherit"
                    >
                      {formatDate(r.txnDate)}
                    </Link>
                  </td>
                  <td className="px-2 py-1">{TXN_LABELS[r.txnType] ?? r.txnType}</td>
                  <td className="px-2 py-1">{r.number}</td>
                  <td className="px-2 py-1">{r.name}</td>
                  <td className="max-w-xs truncate px-2 py-1 text-gray-600">{r.description}</td>
                  <td className="px-2 py-1 text-gray-600">{r.split}</td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    <Amount value={r.debit} />
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    <Amount value={r.credit} />
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    <Amount value={r.balance} />
                  </td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td colSpan={6} className="border-t border-gray-300 px-2 py-1">
                  Total for {acc.label}
                </td>
                <td className="border-t border-gray-300 px-2 py-1 text-right tabular-nums">
                  <Amount value={acc.totalDebit} />
                </td>
                <td className="border-t border-gray-300 px-2 py-1 text-right tabular-nums">
                  <Amount value={acc.totalCredit} />
                </td>
                <td className="border-t border-gray-300 px-2 py-1 text-right tabular-nums">
                  <Amount value={acc.endingBalance} />
                </td>
              </tr>
            </tbody>
          ))}
        </table>
        {report.accounts.length === 0 && (
          <p className="py-8 text-center text-sm text-gray-500">No transactions in this period.</p>
        )}
      </div>
      <Notes truncated={report.truncated} />
    </div>
  );
}
