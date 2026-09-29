'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  formatDate,
  formatMoney,
  type DrillRowDto,
  type TieOutReportDto,
  type TieOutSectionDto,
} from '@acct/shared';
import { txnHref } from '@/lib/links';
import { Alert, Badge, Card, Dialog, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';
import { base } from './import-api';

const ORIGIN_LABELS: Record<NonNullable<TieOutSectionDto['origin']>, string> = {
  source: 'from QuickBooks',
  upload: 'from the uploaded report',
  computed: 'from the file’s own GL lines',
};

function Section({
  s,
  onDrill,
  testId,
}: {
  s: TieOutSectionDto;
  onDrill?: (row: TieOutSectionDto['rows'][number]) => void;
  testId: string;
}) {
  const [all, setAll] = useState(false);
  const rows = all ? s.rows : s.rows.filter((r) => r.difference !== '0.00');
  return (
    <Card className="mb-4" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2">
        <div>
          <span className="font-medium">{s.label}</span>{' '}
          {s.origin && <span className="text-xs text-gray-500">({ORIGIN_LABELS[s.origin]})</span>}
        </div>
        <div className="flex items-center gap-3">
          {s.differences === 0 ? (
            <Badge tone="green">Ties out</Badge>
          ) : (
            <Badge tone="amber">
              {s.differences} difference{s.differences === 1 ? '' : 's'}
            </Badge>
          )}
          <button
            type="button"
            className="text-xs text-brand-700 hover:underline"
            onClick={() => setAll(!all)}
          >
            {all ? 'Differences only' : `All ${s.rows.length} rows`}
          </button>
        </div>
      </div>
      {rows.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-1">Name</th>
              <th className="px-4 py-1 text-right">QuickBooks</th>
              <th className="px-4 py-1 text-right">Here</th>
              <th className="px-4 py-1 text-right">Difference</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {rows.map((r) => (
              <tr
                key={`${r.id}-${r.name}`}
                className={r.difference !== '0.00' ? 'bg-amber-50' : undefined}
              >
                <td className="px-4 py-1">
                  {onDrill ? (
                    <button
                      type="button"
                      className="text-left text-brand-700 hover:underline"
                      onClick={() => onDrill(r)}
                    >
                      {r.name}
                    </button>
                  ) : (
                    r.name
                  )}
                  {!r.id && <span className="ml-2 text-xs text-gray-500">(no match here)</span>}
                </td>
                <td className="px-4 py-1 text-right tabular-nums">{formatMoney(r.source)}</td>
                <td className="px-4 py-1 text-right tabular-nums">{formatMoney(r.ours)}</td>
                <td className="px-4 py-1 text-right tabular-nums">
                  {r.difference === '0.00' ? '' : formatMoney(r.difference)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Drill({
  companyId,
  migrationId,
  target,
  onClose,
}: {
  companyId: string;
  migrationId: string;
  target: { accountId: string | null; name: string; asOf: string };
  onClose: () => void;
}) {
  const qs = new URLSearchParams({ asOf: target.asOf });
  if (target.accountId) qs.set('accountId', target.accountId);
  else qs.set('sourceName', target.name);
  const q = useQuery({
    queryKey: [...keys.migrations(companyId), migrationId, 'drill', target],
    queryFn: () => api<DrillRowDto[]>(`${base(companyId, migrationId)}/report/drill?${qs}`),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${target.name}, through ${formatDate(target.asOf)}`}
      wide
    >
      {q.isLoading ? (
        <Spinner />
      ) : !q.data?.length ? (
        <p className="text-sm text-gray-600">No transactions.</p>
      ) : (
        <table className="w-full text-sm" data-testid="drill">
          <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="py-1">Date</th>
              <th className="py-1">Type</th>
              <th className="py-1">No.</th>
              <th className="py-1 text-right">QuickBooks</th>
              <th className="py-1 text-right">Here</th>
              <th className="py-1">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {q.data.map((r, i) => (
              <tr
                key={i}
                className={
                  r.status !== 'imported' || (r.difference && r.difference !== '0.00')
                    ? 'bg-amber-50'
                    : undefined
                }
              >
                <td className="py-1">{r.txnDate ? formatDate(r.txnDate) : ''}</td>
                <td className="py-1">{r.sourceType ?? r.txnType}</td>
                <td className="py-1">
                  {r.txnId && r.txnType ? (
                    <Link
                      className="text-brand-700 hover:underline"
                      href={txnHref(companyId, r.txnType, r.txnId)}
                    >
                      {r.number ?? 'Open'}
                    </Link>
                  ) : (
                    r.number
                  )}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {r.source ? formatMoney(r.source) : '—'}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {r.ours ? formatMoney(r.ours) : '—'}
                </td>
                <td className="py-1 text-xs">
                  {r.status === 'imported'
                    ? 'Imported'
                    : r.status === 'only_here'
                      ? 'Entered here'
                      : (r.message ?? 'Not imported')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Dialog>
  );
}

/** The Migration Report: QuickBooks' figures against the imported books. */
export function TieOut({
  companyId,
  migrationId,
  report,
}: {
  companyId: string;
  migrationId: string;
  report: TieOutReportDto;
}) {
  const [drill, setDrill] = useState<{
    accountId: string | null;
    name: string;
    asOf: string;
  } | null>(null);
  return (
    <div data-testid="tie-out">
      {report.status === 'tied_out' ? (
        <Alert kind="success">
          Every figure ties out: each trial balance, bank and card balances, and A/R and A/P by
          customer and vendor.
        </Alert>
      ) : report.status === 'no_source' ? (
        <Alert kind="info">There are no QuickBooks figures to compare with yet.</Alert>
      ) : (
        <Alert>
          {report.differences} difference{report.differences === 1 ? '' : 's'}. Select an account to
          see the transactions behind it.
        </Alert>
      )}
      {(report.records.errors > 0 || report.records.pending > 0) && (
        <div className="mt-2">
          <Alert>
            {report.records.errors} record{report.records.errors === 1 ? '' : 's'} couldn’t be
            imported
            {report.records.pending ? ` and ${report.records.pending} are waiting` : ''}. They’re
            listed below.
          </Alert>
        </div>
      )}
      <div className="mt-4">
        {report.trialBalances.map((s) => (
          <Section
            key={s.asOf}
            s={s}
            testId={`tb-${s.asOf}`}
            onDrill={(r) => setDrill({ accountId: r.id, name: r.name, asOf: s.asOf })}
          />
        ))}
        {report.bankBalances && report.bankBalances.rows.length > 0 && (
          <Section s={report.bankBalances} testId="bank-balances" />
        )}
        {report.arAging && <Section s={report.arAging} testId="ar-aging" />}
        {report.apAging && <Section s={report.apAging} testId="ap-aging" />}
      </div>
      <details className="mt-2 text-sm text-gray-600">
        <summary className="cursor-pointer">Not compared yet</summary>
        <ul className="mt-1 list-disc pl-5">
          {report.notCompared.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </details>
      {drill && (
        <Drill
          companyId={companyId}
          migrationId={migrationId}
          target={drill}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}
