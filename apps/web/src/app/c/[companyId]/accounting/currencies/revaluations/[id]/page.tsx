'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatCurrency, formatDate, type RevaluationDto } from '@acct/shared';
import { Alert, Badge, Button, Card, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, ledgerKeys, useAccess } from '@/lib/queries';

/** One currency revaluation and its reversal (ADR 0020). */
export default function RevaluationPage() {
  const { companyId, id } = useParams<{ companyId: string; id: string }>();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const [error, setError] = useState<string | null>(null);
  const r = useQuery({
    queryKey: [...keys.currencies(companyId), 'revaluation', id],
    queryFn: () => api<RevaluationDto>(`/companies/${companyId}/currencies/revaluations/${id}`),
  });
  if (r.isPending) return <Spinner />;
  if (!r.data) return <Alert>{errorMessage(r.error)}</Alert>;
  const v = r.data;
  return (
    <Card className="max-w-4xl p-6" data-testid="revaluation-detail">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            Currency revaluation as of {formatDate(v.txnDate)}{' '}
            {v.status === 'void' && <Badge>Void</Badge>}
          </h2>
          <p className="text-sm text-gray-600">
            {v.memo}
            {v.reversalDate && ` · Reversed on ${formatDate(v.reversalDate)}`}
          </p>
        </div>
        <Link
          href={`/c/${companyId}/accounting/currencies`}
          className="text-sm text-brand-700 hover:underline"
        >
          ← Currencies
        </Link>
      </div>
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-gray-600">
            <th className="py-2 font-medium">Customer or vendor</th>
            <th className="py-2 font-medium">Account</th>
            <th className="py-2 font-medium">Revalued</th>
            <th className="py-2 text-right font-medium">Gain (loss)</th>
          </tr>
        </thead>
        <tbody>
          {v.lines.map((l, i) => (
            <tr key={i} className="border-b border-gray-100">
              <td className="py-2">{l.partyName}</td>
              <td className="py-2">{l.accountName}</td>
              <td className="py-2 text-gray-600">{l.description}</td>
              <td className="py-2 text-right tabular-nums">{formatCurrency(l.gainLoss, null)}</td>
            </tr>
          ))}
          <tr className="font-semibold">
            <td className="py-2" colSpan={3}>
              Total unrealized gain (loss)
            </td>
            <td className="py-2 text-right tabular-nums">
              {formatCurrency(v.totalGainLoss, null)}
            </td>
          </tr>
        </tbody>
      </table>
      {access.can('ledger.manage') && v.status === 'posted' && (
        <div className="mt-4">
          <Button
            type="button"
            variant="secondary"
            onClick={async () => {
              setError(null);
              try {
                await api(`/companies/${companyId}/currencies/revaluations/${v.id}/void`, {
                  method: 'POST',
                  body: {},
                });
                await Promise.all([
                  qc.invalidateQueries({ queryKey: keys.currencies(companyId) }),
                  ...ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })),
                ]);
              } catch (err) {
                setError(errorMessage(err));
              }
            }}
          >
            Void revaluation and its reversal
          </Button>
        </div>
      )}
    </Card>
  );
}
