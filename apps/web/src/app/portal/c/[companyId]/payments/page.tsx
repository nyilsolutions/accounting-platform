'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatDate, formatMoney, todayIso, type PortalPaymentDto } from '@acct/shared';
import { portalApi, usePortalLink } from '@/components/portal/portal-context';
import { Alert, Card, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

const TYPES: Record<string, string> = {
  bill_payment: 'Bill payment',
  check: 'Check',
  expense: 'Payment',
};

/** A contractor's payments from the business, by year. */
export default function PortalPaymentsPage() {
  const link = usePortalLink();
  const now = Number(todayIso().slice(0, 4));
  const [year, setYear] = useState(now);
  const q = useQuery({
    queryKey: ['portal', link.companyId, 'payments', year],
    queryFn: () => api<PortalPaymentDto[]>(portalApi(link.companyId, `/payments/${year}`)),
  });
  return (
    <div className="space-y-4">
      <label className="text-sm">
        <span className="mr-2 text-gray-700">Year</span>
        <select
          aria-label="Year"
          className="rounded-md border border-gray-300 px-2 py-1"
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
        >
          {[now, now - 1, now - 2, now - 3].map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </label>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert>{errorMessage(q.error)}</Alert>
      ) : q.data.length === 0 ? (
        <Card className="p-6 text-sm text-gray-600">No payments in {year}.</Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="portal-payments">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2">Payment</th>
                <th className="px-4 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {q.data.map((p) => (
                <tr key={p.txnId}>
                  <td className="px-4 py-2">{formatDate(p.date)}</td>
                  <td className="px-4 py-2">
                    {TYPES[p.txnType] ?? 'Payment'}
                    {p.number ? ` ${p.number}` : ''}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">${formatMoney(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
