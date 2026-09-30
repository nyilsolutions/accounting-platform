'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  formatDate,
  formatCurrency,
  formatMoney,
  TXN_TYPE_LABELS,
  type PurchaseTransactionPageDto,
} from '@acct/shared';
import { PaymentStatusBadge } from '@/components/sales/status-badge';
import { Badge, Button, Card, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { txnHref, vendorHref } from '@/lib/links';
import { keys } from '@/lib/queries';

const TYPES: Array<[string, string]> = [
  ['all', 'All transactions'],
  ['bill', 'Bills'],
  ['bill_payment', 'Bill payments'],
  ['check', 'Checks'],
  ['expense', 'Expenses'],
  ['vendor_credit', 'Vendor credits'],
  ['cc_credit', 'Credit card credits'],
];

const STATUSES: Array<[string, string]> = [
  ['all', 'All statuses'],
  ['open', 'Unpaid bills'],
  ['overdue', 'Overdue bills'],
  ['paid', 'Paid bills'],
];

/** Purchase transactions with type/status filters, search and "load more" paging. */
export function PurchaseTransactionsTable({
  companyId,
  vendorId,
}: {
  companyId: string;
  vendorId?: string;
}) {
  const router = useRouter();
  const [type, setType] = useState('all');
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [includeVoid, setIncludeVoid] = useState(false);
  const filters = { type, status, search, includeVoid, vendorId };
  const list = useInfiniteQuery({
    queryKey: [...keys.sales(companyId), 'purchase-transactions', filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: '50', type, status });
      if (search) qs.set('search', search);
      if (includeVoid) qs.set('includeVoid', 'true');
      if (vendorId) qs.set('vendorId', vendorId);
      if (pageParam) qs.set('cursor', pageParam);
      return api<PurchaseTransactionPageDto>(
        `/companies/${companyId}/purchases/transactions?${qs}`,
      );
    },
    getNextPageParam: (last) => last.nextCursor,
  });
  const rows = list.data?.pages.flatMap((p) => p.transactions) ?? [];

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <select
          aria-label="Transaction type"
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="rounded-md border border-gray-300 px-2 py-1.5"
        >
          {TYPES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select
          aria-label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-md border border-gray-300 px-2 py-1.5"
        >
          {STATUSES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search number, memo or payee"
          aria-label="Search expenses"
          className="w-64 rounded-md border border-gray-300 px-3 py-1.5"
        />
        <label className="flex items-center gap-2 text-gray-600">
          <input
            type="checkbox"
            checked={includeVoid}
            onChange={(e) => setIncludeVoid(e.target.checked)}
          />{' '}
          Include voided
        </label>
      </div>
      <Card>
        {list.isPending ? (
          <Spinner />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm" data-testid="purchase-transactions">
              <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2">Date</th>
                  <th className="px-4 py-2">Type</th>
                  <th className="px-4 py-2">No.</th>
                  {!vendorId && <th className="px-4 py-2">Payee</th>}
                  <th className="px-4 py-2">Due date</th>
                  <th className="px-4 py-2 text-right">Balance</th>
                  <th className="px-4 py-2 text-right">Total</th>
                  <th className="px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((t) => (
                  <tr
                    key={t.id}
                    className="cursor-pointer hover:bg-gray-50"
                    onClick={() => router.push(txnHref(companyId, t.txnType, t.id))}
                  >
                    <td className="whitespace-nowrap px-4 py-2">{formatDate(t.txnDate)}</td>
                    <td className="px-4 py-2">{TXN_TYPE_LABELS[t.txnType] ?? t.txnType}</td>
                    <td className="px-4 py-2">
                      {t.number}{' '}
                      {t.printStatus === 'to_print' && <Badge tone="amber">To print</Badge>}
                    </td>
                    {!vendorId && (
                      <td className="px-4 py-2">
                        {t.vendorId ? (
                          <Link
                            href={vendorHref(companyId, t.vendorId)}
                            onClick={(e) => e.stopPropagation()}
                            className="text-brand-700 hover:underline"
                          >
                            {t.vendorName}
                          </Link>
                        ) : null}
                      </td>
                    )}
                    <td className="px-4 py-2">{t.dueDate ? formatDate(t.dueDate) : ''}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {t.txnType === 'bill' || t.txnType === 'vendor_credit'
                        ? t.currency
                          ? formatCurrency(t.balance, t.currency)
                          : formatMoney(t.balance)
                        : ''}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {t.currency ? formatCurrency(t.total, t.currency) : formatMoney(t.total)}
                    </td>
                    <td className="px-4 py-2">
                      <PaymentStatusBadge status={t.paymentStatus} />
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                      No expenses match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {list.hasNextPage && (
        <Button
          variant="secondary"
          className="mt-4"
          onClick={() => list.fetchNextPage()}
          loading={list.isFetchingNextPage}
        >
          Load more
        </Button>
      )}
    </>
  );
}
