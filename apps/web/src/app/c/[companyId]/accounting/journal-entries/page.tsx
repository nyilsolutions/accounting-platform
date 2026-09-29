'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { formatDate, formatMoney, type JournalEntryPageDto } from '@acct/shared';
import { Badge, Button, buttonClass, Card, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { keys, useAccess } from '@/lib/queries';

export default function JournalEntriesPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const router = useRouter();
  const access = useAccess(companyId);
  const [search, setSearch] = useState('');
  const [includeVoid, setIncludeVoid] = useState(false);
  const list = useInfiniteQuery({
    queryKey: [...keys.journal(companyId), { search, includeVoid }],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: '50' });
      if (search) qs.set('search', search);
      if (includeVoid) qs.set('includeVoid', 'true');
      if (pageParam) qs.set('cursor', pageParam);
      return api<JournalEntryPageDto>(`/companies/${companyId}/journal-entries?${qs}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
  const entries = list.data?.pages.flatMap((p) => p.entries) ?? [];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search number or memo"
            aria-label="Search journal entries"
            className="w-64 rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={includeVoid}
              onChange={(e) => setIncludeVoid(e.target.checked)}
            />{' '}
            Include voided
          </label>
        </div>
        {access.can('ledger.manage') && (
          <Link href={`/c/${companyId}/accounting/journal-entries/new`} className={buttonClass()}>
            New journal entry
          </Link>
        )}
      </div>
      <Card>
        {list.isPending ? (
          <Spinner />
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2">No.</th>
                <th className="px-4 py-2">Accounts</th>
                <th className="px-4 py-2">Memo</th>
                <th className="px-4 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {entries.map((e) => (
                <tr
                  key={e.id}
                  className="cursor-pointer hover:bg-gray-50"
                  onClick={() => router.push(`/c/${companyId}/accounting/journal-entries/${e.id}`)}
                >
                  <td className="px-4 py-2 whitespace-nowrap">{formatDate(e.txnDate)}</td>
                  <td className="px-4 py-2">
                    {e.number} {e.status === 'void' && <Badge tone="amber">Void</Badge>}{' '}
                    {e.isAdjusting && <Badge>Adjusting</Badge>}
                  </td>
                  <td className="px-4 py-2 text-gray-700">{e.accounts.join(', ')}</td>
                  <td className="max-w-xs truncate px-4 py-2 text-gray-600">{e.memo}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatMoney(e.total)}</td>
                </tr>
              ))}
              {entries.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                    No journal entries yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
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
