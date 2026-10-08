'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { AuditEntryDto, AuditPageDto } from '@acct/shared';
import { Button, Card, PageHeader, Spinner, TextInput } from '@/components/ui';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';

interface Filters {
  entityId?: string;
  action?: string;
  from?: string;
  to?: string;
}

export default function AuditLogPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <AuditLog />
    </Suspense>
  );
}

function AuditLog() {
  const { companyId } = useParams<{ companyId: string }>();
  const params = useSearchParams();
  const [filters, setFilters] = useState<Filters>(() =>
    params.get('entity') ? { entityId: params.get('entity')! } : {},
  );

  const log = useInfiniteQuery({
    queryKey: keys.audit(companyId, filters),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: '50' });
      for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
      if (pageParam) qs.set('cursor', pageParam);
      return api<AuditPageDto>(`/companies/${companyId}/audit-log?${qs}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });

  function applyFilters(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setFilters({
      action: String(f.get('action') || '') || undefined,
      from: String(f.get('from') || '') || undefined,
      to: String(f.get('to') || '') || undefined,
    });
  }

  const entries = log.data?.pages.flatMap((p) => p.entries) ?? [];

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every change to this company, who made it, and when. Entries cannot be edited or deleted."
      />
      {filters.entityId && (
        <p className="mb-3 text-sm text-gray-600">
          Showing the history of one record.{' '}
          <button className="text-brand-700 hover:underline" onClick={() => setFilters({})}>
            Show all
          </button>
        </p>
      )}
      <Card className="mb-4 p-4">
        <form
          onSubmit={applyFilters}
          className="grid items-end gap-3 sm:grid-cols-[1fr_10rem_10rem_auto]"
        >
          <TextInput
            label="Event starts with"
            name="action"
            placeholder="e.g. member. or company.updated"
          />
          <TextInput label="From" name="from" type="date" />
          <TextInput label="To" name="to" type="date" />
          <Button type="submit" variant="secondary">
            Filter
          </Button>
        </form>
      </Card>
      <Card>
        {log.isPending ? (
          <Spinner />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2">When</th>
                  <th className="px-4 py-2">User</th>
                  <th className="px-4 py-2">Event</th>
                  <th className="px-4 py-2">Details</th>
                  <th className="px-4 py-2">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 align-top">
                {entries.map((e) => (
                  <tr key={e.id} data-testid="audit-row">
                    <td className="whitespace-nowrap px-4 py-2 text-gray-600">
                      {new Date(e.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-2">{e.actor?.email ?? 'System'}</td>
                    <td className="px-4 py-2 font-mono text-xs">{e.action}</td>
                    <td className="px-4 py-2">
                      <Changes entry={e} />
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-500">{e.ip}</td>
                  </tr>
                ))}
                {entries.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-gray-500">
                      No matching events.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {log.hasNextPage && (
        <Button
          variant="secondary"
          className="mt-4"
          onClick={() => log.fetchNextPage()}
          loading={log.isFetchingNextPage}
        >
          Load more
        </Button>
      )}
    </>
  );
}

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function Changes({ entry }: { entry: AuditEntryDto }) {
  const before = (entry.before ?? {}) as Record<string, unknown>;
  const after = (entry.after ?? {}) as Record<string, unknown>;
  const keysList = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
  if (keysList.length === 0) return <span className="text-gray-400">—</span>;
  return (
    <ul className="space-y-0.5 text-xs">
      {keysList.map((k) => (
        <li key={k}>
          <span className="text-gray-500">{k}:</span>{' '}
          {k in before && <span className="text-red-700 line-through">{fmt(before[k])}</span>}
          {k in before && k in after && ' → '}
          {k in after && <span className="text-emerald-800">{fmt(after[k])}</span>}
        </li>
      ))}
    </ul>
  );
}
