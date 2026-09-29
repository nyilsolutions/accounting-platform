'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatDate, formatMoney, type PurchaseOrderDto } from '@acct/shared';
import { Badge, buttonClass, Card, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { keys, useAccess } from '@/lib/queries';

export default function PurchaseOrdersPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const router = useRouter();
  const access = useAccess(companyId);
  const [status, setStatus] = useState('open');
  const list = useQuery({
    queryKey: [...keys.sales(companyId), 'purchase-orders'],
    queryFn: () => api<PurchaseOrderDto[]>(`/companies/${companyId}/purchase-orders`),
  });
  const rows = (list.data ?? []).filter((p) => status === 'all' || p.status === status);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <select
          aria-label="Purchase order status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
        >
          <option value="open">Open</option>
          <option value="closed">Closed</option>
          <option value="all">All</option>
        </select>
        {access.can('purchases.manage') && (
          <Link href={`/c/${companyId}/expenses/purchase-orders/new`} className={buttonClass()}>
            New purchase order
          </Link>
        )}
      </div>
      <Card>
        {list.isPending ? (
          <Spinner />
        ) : (
          <table className="w-full text-sm" data-testid="purchase-orders-table">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2">P.O. no.</th>
                <th className="px-4 py-2">Vendor</th>
                <th className="px-4 py-2">Expected</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((p) => (
                <tr
                  key={p.id}
                  className="cursor-pointer hover:bg-gray-50"
                  onClick={() => router.push(`/c/${companyId}/expenses/purchase-orders/${p.id}`)}
                >
                  <td className="whitespace-nowrap px-4 py-2">{formatDate(p.txnDate)}</td>
                  <td className="px-4 py-2">{p.number}</td>
                  <td className="px-4 py-2">{p.vendorName}</td>
                  <td className="px-4 py-2">{p.expectedDate ? formatDate(p.expectedDate) : ''}</td>
                  <td className="px-4 py-2">
                    <Badge tone={p.status === 'open' ? 'gray' : 'green'}>
                      {p.billId ? 'Billed' : p.status === 'open' ? 'Open' : 'Closed'}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatMoney(p.total)}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                    No purchase orders.
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
