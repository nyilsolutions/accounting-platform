'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { formatDate, formatMoney, type PortalPaycheckDto } from '@acct/shared';
import { portalApi, usePortalLink } from '@/components/portal/portal-context';
import { Alert, Badge, Card, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

/** The employee's pay stubs, newest first. */
export default function PortalPaychecksPage() {
  const link = usePortalLink();
  const q = useQuery({
    queryKey: ['portal', link.companyId, 'paychecks'],
    queryFn: () => api<PortalPaycheckDto[]>(portalApi(link.companyId, '/paychecks')),
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert>{errorMessage(q.error)}</Alert>;
  if (q.data.length === 0)
    return <Card className="p-6 text-sm text-gray-600">No pay stubs yet.</Card>;
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="portal-paychecks">
        <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-4 py-2">Pay date</th>
            <th className="px-4 py-2">Period</th>
            <th className="px-4 py-2 text-right">Gross pay</th>
            <th className="px-4 py-2 text-right">Net pay</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {q.data.map((p) => (
            <tr key={p.id}>
              <td className="px-4 py-2">
                <Link
                  href={`/portal/c/${link.companyId}/paychecks/${p.id}`}
                  className="text-brand-700 hover:underline"
                >
                  {formatDate(p.payDate)}
                </Link>
              </td>
              <td className="px-4 py-2 text-gray-600">
                {p.periodStart && p.periodEnd
                  ? `${formatDate(p.periodStart)} – ${formatDate(p.periodEnd)}`
                  : '—'}
              </td>
              <td className="px-4 py-2 text-right tabular-nums">${formatMoney(p.grossPay)}</td>
              <td className="px-4 py-2 text-right tabular-nums">${formatMoney(p.netPay)}</td>
              <td className="px-4 py-2 text-right">
                {p.status === 'void' && <Badge tone="gray">Void</Badge>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
