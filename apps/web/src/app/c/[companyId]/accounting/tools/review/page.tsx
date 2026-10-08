'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { TXN_TYPE_LABELS, type ClientChangeDto, type ClientChangesDto } from '@acct/shared';
import { Alert, Badge, Button, Card, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { txnHref } from '@/lib/links';
import { keys, useAccess } from '@/lib/queries';

type Status = 'unreviewed' | 'reviewed' | 'all';

function changeText(c: ClientChangeDto): string {
  const [, verb] = c.action.split('.');
  const what = c.txnType ? (TXN_TYPE_LABELS[c.txnType] ?? c.txnType) : (c.entityType ?? '');
  return `${what}${c.txnNumber ? ` #${c.txnNumber}` : ''} ${verb ?? c.action}`.trim();
}

/** What changed, field by field (before → after). */
function Diff({
  before,
  after,
}: {
  before: ClientChangeDto['before'];
  after: ClientChangeDto['after'];
}) {
  const keysOf = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  const show = (v: unknown) =>
    v === undefined || v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const rows = keysOf.filter((k) => show(before?.[k]) !== show(after?.[k]));
  if (rows.length === 0) return null;
  return (
    <table className="mt-2 w-full text-xs">
      <tbody>
        {rows.map((k) => (
          <tr key={k} className="align-top">
            <td className="w-28 py-0.5 pr-2 text-gray-500">{k}</td>
            <td className="py-0.5 pr-2 text-red-700 line-through">
              {before ? show(before[k]) : ''}
            </td>
            <td className="py-0.5 text-emerald-800">{after ? show(after[k]) : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Accountant tools › Review client changes (ADR 0021). */
export default function ReviewPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const [status, setStatus] = useState<Status>('unreviewed');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({
    queryKey: [...keys.accountant(companyId), 'changes', status],
    queryFn: () =>
      api<ClientChangesDto>(`/companies/${companyId}/accountant/client-changes?status=${status}`),
  });
  const changes = q.data?.changes ?? [];

  async function mark(ids: string[], reviewed: boolean) {
    setError(null);
    try {
      await api(
        `/companies/${companyId}/accountant/client-changes/${reviewed ? 'review' : 'unreview'}`,
        { method: 'POST', body: { ids } },
      );
      setPicked(new Set());
      await qc.invalidateQueries({ queryKey: keys.accountant(companyId) });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const canManage = access.can('ledger.manage');
  return (
    <div className="space-y-4" data-testid="client-changes">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Review client changes</h2>
          <p className="text-sm text-gray-600">
            Transactions and accounts added, changed, voided or deleted by the client&apos;s people.
            {q.data && ` ${q.data.unreviewed} to review.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label="Show"
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as Status);
              setPicked(new Set());
            }}
          >
            <option value="unreviewed">To review</option>
            <option value="reviewed">Reviewed</option>
            <option value="all">All</option>
          </select>
          {canManage && status !== 'reviewed' && (
            <>
              <Button
                type="button"
                variant="secondary"
                disabled={picked.size === 0}
                onClick={() => mark([...picked], true)}
              >
                Mark {picked.size || ''} reviewed
              </Button>
              <Button
                type="button"
                disabled={changes.filter((c) => !c.reviewedBy).length === 0}
                onClick={() =>
                  mark(
                    changes.filter((c) => !c.reviewedBy).map((c) => c.id),
                    true,
                  )
                }
              >
                Mark all shown reviewed
              </Button>
            </>
          )}
        </div>
      </div>
      {error && <Alert>{error}</Alert>}
      {q.isPending ? (
        <Spinner />
      ) : changes.length === 0 ? (
        <Card className="p-6 text-sm text-gray-600">Nothing here.</Card>
      ) : (
        <Card className="divide-y divide-gray-100">
          {changes.map((c) => (
            <div key={c.id} className="flex gap-3 p-4" data-testid="client-change">
              {canManage && !c.reviewedBy && (
                <input
                  type="checkbox"
                  aria-label={`Select ${changeText(c)}`}
                  checked={picked.has(c.id)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(c.id);
                    else next.delete(c.id);
                    setPicked(next);
                  }}
                  className="mt-1"
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">
                    {c.txnType && c.entityId && !c.action.endsWith('deleted') ? (
                      <Link
                        href={txnHref(companyId, c.txnType, c.entityId)}
                        className="text-brand-700 hover:underline"
                      >
                        {changeText(c)}
                      </Link>
                    ) : (
                      changeText(c)
                    )}
                  </span>
                  {c.txnDate && <span className="text-gray-500">dated {c.txnDate}</span>}
                  {c.inClosedPeriod && <Badge tone="amber">Closed period</Badge>}
                  {c.reviewedBy && <Badge tone="green">Reviewed by {c.reviewedBy}</Badge>}
                </div>
                <p className="text-xs text-gray-500">
                  {c.actorName}
                  {c.actorRole ? ` (${c.actorRole})` : ''} · {new Date(c.at).toLocaleString()}
                </p>
                <Diff before={c.before} after={c.after} />
              </div>
              {canManage && c.reviewedBy && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => mark([c.id], false)}
                >
                  Unmark
                </Button>
              )}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
