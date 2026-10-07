'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChangeRequestDto } from '@acct/shared';
import { Alert, Badge, Button, Card, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAccess } from '@/lib/queries';

type Status = 'pending' | 'all';
const STATUS: Record<
  ChangeRequestDto['status'],
  { label: string; tone: 'amber' | 'green' | 'red' | 'gray' }
> = {
  pending: { label: 'Waiting', tone: 'amber' },
  approved: { label: 'Approved', tone: 'green' },
  rejected: { label: 'Rejected', tone: 'red' },
  withdrawn: { label: 'Withdrawn', tone: 'gray' },
};

/**
 * Payroll › Employee requests: W-4 and direct deposit changes employees asked for in their
 * portal (ADR 0023). Approving applies them as if entered here; new accounts are prenoted.
 */
export default function EmployeeRequestsPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const [status, setStatus] = useState<Status>('pending');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['company', companyId, 'change-requests', status],
    queryFn: () =>
      api<ChangeRequestDto[]>(`/companies/${companyId}/portal/change-requests?status=${status}`),
  });

  async function decide(r: ChangeRequestDto, decision: 'approve' | 'reject') {
    setError(null);
    setNotice(null);
    try {
      await api(`/companies/${companyId}/portal/change-requests/${r.id}/${decision}`, {
        method: 'POST',
        body: { note: notes[r.id] || undefined },
      });
      setNotice(
        `${decision === 'approve' ? 'Approved' : 'Rejected'} ${r.employeeName}'s ${r.kind === 'w4' ? 'W-4' : 'direct deposit'} request.`,
      );
      await qc.invalidateQueries({ queryKey: ['company', companyId] });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const canManage = access.can('payroll.manage');
  return (
    <div className="space-y-4" data-testid="employee-requests">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Employee requests</h2>
          <p className="text-sm text-gray-600">
            W-4 and direct deposit changes employees asked for in their portal.
          </p>
        </div>
        <select
          aria-label="Show"
          className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          value={status}
          onChange={(e) => setStatus(e.target.value as Status)}
        >
          <option value="pending">Waiting</option>
          <option value="all">All</option>
        </select>
      </div>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert>{errorMessage(q.error)}</Alert>
      ) : q.data.length === 0 ? (
        <Card className="p-6 text-sm text-gray-600">No requests.</Card>
      ) : (
        <Card className="divide-y divide-gray-100">
          {q.data.map((r) => (
            <div key={r.id} className="p-4 text-sm" data-testid="change-request">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/c/${companyId}/payroll/employees/${r.employeeId}`}
                  className="font-medium text-brand-700 hover:underline"
                >
                  {r.employeeName}
                </Link>
                <span>{r.kind === 'w4' ? 'New Form W-4' : 'New direct deposit'}</span>
                <span className="text-gray-500">{new Date(r.requestedAt).toLocaleString()}</span>
                <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                {r.decidedBy && <span className="text-gray-500">by {r.decidedBy}</span>}
              </div>
              <ul className="mt-2 text-gray-700">
                {r.summary.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              {r.note && <p className="mt-1 text-gray-600">Note: {r.note}</p>}
              {r.status === 'pending' && canManage && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    aria-label={`Note for ${r.employeeName}`}
                    placeholder="Note to the employee (optional)"
                    className="w-72 rounded-md border border-gray-300 px-2 py-1"
                    value={notes[r.id] ?? ''}
                    onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })}
                  />
                  <Button size="sm" onClick={() => decide(r, 'approve')}>
                    Approve
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => decide(r, 'reject')}>
                    Reject
                  </Button>
                </div>
              )}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
