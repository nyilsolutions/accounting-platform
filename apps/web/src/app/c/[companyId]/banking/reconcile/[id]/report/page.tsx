'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  formatDate,
  formatMoney,
  parseMoney,
  TXN_TYPE_LABELS,
  type ReconciliationReportDto,
  type ReconciliationReportSection,
} from '@acct/shared';
import { Alert, Button, Card, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, useCompany } from '@/lib/queries';

function Section({ s }: { s: ReconciliationReportSection }) {
  return (
    <div className="mb-4 break-inside-avoid">
      <div className="flex justify-between border-b border-gray-300 py-1 font-medium">
        <span>
          {s.label} ({s.items.length})
        </span>
        <span className="tabular-nums">{formatMoney(s.total)}</span>
      </div>
      {s.items.length > 0 && (
        <table className="w-full text-sm">
          <tbody>
            {s.items.map((i) => (
              <tr key={i.txnId}>
                <td className="w-28 py-0.5 pl-4">{formatDate(i.txnDate)}</td>
                <td className="w-36 py-0.5">{TXN_TYPE_LABELS[i.txnType] ?? i.txnType}</td>
                <td className="w-20 py-0.5">{i.number}</td>
                <td className="py-0.5">{i.payee ?? i.memo}</td>
                <td className="py-0.5 text-right tabular-nums">{formatMoney(i.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Reconciliation report (QuickBooks-style summary and detail), printable. */
export default function ReconciliationReportPage() {
  const { companyId, id } = useParams<{ companyId: string; id: string }>();
  const company = useCompany(companyId);
  const report = useQuery({
    queryKey: [...keys.banking(companyId), 'reconciliation-report', id],
    queryFn: () =>
      api<ReconciliationReportDto>(`/companies/${companyId}/reconciliations/${id}/report`),
  });
  if (report.isError) return <Alert>{errorMessage(report.error)}</Alert>;
  if (report.isPending) return <Spinner />;
  const r = report.data;
  const rec = r.reconciliation;
  const clearedTotal = r.cleared.reduce((s, x) => s + parseMoney(x.total), 0n);
  const unclearedTotal = r.uncleared.reduce((s, x) => s + parseMoney(x.total), 0n);
  return (
    <>
      <div className="mb-4 flex items-center justify-between print:hidden">
        <Link
          href={`/c/${companyId}/banking/reconcile`}
          className="text-sm text-brand-700 hover:underline"
        >
          ← Reconcile
        </Link>
        <Button variant="secondary" onClick={() => window.print()}>
          Print
        </Button>
      </div>
      <Card className="mx-auto max-w-4xl p-8 print:border-0 print:shadow-none">
        <div className="mb-6 text-center" data-testid="reconciliation-report">
          <div className="text-sm text-gray-600">{company.data?.legalName}</div>
          <h2 className="text-xl font-semibold text-gray-900">
            {r.accountName}, Period Ending {formatDate(rec.statementDate)}
          </h2>
          <div className="text-sm text-gray-600">Reconciliation Report</div>
          {rec.completedAt && (
            <div className="text-xs text-gray-500">
              Reconciled on {new Date(rec.completedAt).toLocaleString()}{' '}
              {rec.completedByName && `by ${rec.completedByName}`}
              {rec.status === 'undone' && ' · undone'}
            </div>
          )}
        </div>
        <h3 className="mb-2 font-semibold">Summary</h3>
        <dl className="mb-6 space-y-1 text-sm">
          {(
            [
              ['Statement beginning balance', rec.beginningBalance],
              ['Cleared transactions', clearedTotal],
              ['Statement ending balance', rec.endingBalance],
              ['Uncleared transactions as of the statement date', unclearedTotal],
              ['Register balance as of the statement date', r.registerBalanceAtStatementDate],
              ['Register balance today', r.registerBalanceToday],
            ] as const
          ).map(([label, v]) => (
            <div key={label} className="flex justify-between border-b border-gray-100 py-1">
              <dt>{label}</dt>
              <dd className="tabular-nums">{formatMoney(v)}</dd>
            </div>
          ))}
        </dl>
        <h3 className="mb-2 font-semibold">Details</h3>
        {[...r.cleared, ...r.uncleared, ...r.after].map((s) => (
          <Section key={s.label} s={s} />
        ))}
      </Card>
    </>
  );
}
