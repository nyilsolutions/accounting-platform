'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatDate, formatMoney, todayIso, type EstimateDto } from '@acct/shared';
import { EstimateStatusBadge } from '@/components/sales/status-badge';
import { Badge, buttonClass, Card, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { keys, useAccess } from '@/lib/queries';

export default function EstimatesPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const router = useRouter();
  const access = useAccess(companyId);
  const [status, setStatus] = useState('open');
  const list = useQuery({
    queryKey: [...keys.sales(companyId), 'estimates'],
    queryFn: () => api<EstimateDto[]>(`/companies/${companyId}/estimates`),
  });
  const rows = (list.data ?? []).filter((e) =>
    status === 'all'
      ? true
      : status === 'open'
        ? e.status === 'pending' || e.status === 'accepted'
        : e.status === status,
  );
  const today = todayIso();

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <select
          aria-label="Estimate status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
        >
          <option value="open">Open (pending or accepted)</option>
          <option value="all">All</option>
          <option value="closed">Converted / closed</option>
          <option value="rejected">Rejected</option>
        </select>
        {access.can('sales.manage') && (
          <Link href={`/c/${companyId}/sales/estimates/new`} className={buttonClass()}>
            New estimate
          </Link>
        )}
      </div>
      <Card>
        {list.isPending ? (
          <Spinner />
        ) : (
          <table className="w-full text-sm" data-testid="estimates-table">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2">No.</th>
                <th className="px-4 py-2">Customer</th>
                <th className="px-4 py-2">Expires</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((e) => (
                <tr
                  key={e.id}
                  className="cursor-pointer hover:bg-gray-50"
                  onClick={() => router.push(`/c/${companyId}/sales/estimates/${e.id}`)}
                >
                  <td className="px-4 py-2 whitespace-nowrap">{formatDate(e.txnDate)}</td>
                  <td className="px-4 py-2">{e.number}</td>
                  <td className="px-4 py-2">{e.customerName}</td>
                  <td className="px-4 py-2">
                    {e.expirationDate ? formatDate(e.expirationDate) : ''}{' '}
                    {e.expirationDate && e.expirationDate < today && e.status === 'pending' && (
                      <Badge tone="amber">Expired</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <EstimateStatusBadge status={e.status} />
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatMoney(e.total)}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                    No estimates.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
