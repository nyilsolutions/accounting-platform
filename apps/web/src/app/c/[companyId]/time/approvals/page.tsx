'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, formatDate, type TimeApprovalDto } from '@acct/shared';
import { Alert, Button, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys } from '@/lib/queries';

/** Submitted time waiting for approval, a person's week at a time. */
export default function ApprovalsPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const list = useQuery({
    queryKey: [...keys.time(companyId), 'approvals'],
    queryFn: () => api<TimeApprovalDto[]>(`/companies/${companyId}/time/approvals`),
  });
  if (list.isError) return <Alert>{errorMessage(list.error)}</Alert>;
  if (list.isPending) return <Spinner />;

  async function decide(a: TimeApprovalDto, action: 'approve' | 'reject') {
    setError(null);
    setNotice(null);
    let note: string | undefined;
    if (action === 'reject') {
      note = prompt(`Why is ${a.workerName}'s time rejected?`) ?? undefined;
      if (!note) return;
    }
    try {
      await api(`/companies/${companyId}/time/${action}`, {
        method: 'POST',
        body: { entryIds: a.entryIds, note },
      });
      await qc.invalidateQueries({ queryKey: keys.time(companyId) });
      setNotice(
        `${a.workerName}'s time for the week of ${formatDate(a.weekStart)} was ${action === 'approve' ? 'approved' : 'rejected'}.`,
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {list.data.length === 0 ? (
        <p className="text-sm text-gray-600">No time is waiting for your approval.</p>
      ) : (
        <table className="w-full text-sm" data-testid="time-approvals">
          <thead>
            <tr className="border-b border-gray-300 text-left text-xs uppercase tracking-wide text-gray-500">
              <th className="px-2 py-1">Who</th>
              <th className="px-2 py-1">Week</th>
              <th className="px-2 py-1 text-right">Hours</th>
              <th className="px-2 py-1 text-right">Billable hours</th>
              <th className="px-2 py-1" />
            </tr>
          </thead>
          <tbody>
            {list.data.map((a) => (
              <tr
                key={`${a.employeeId ?? a.vendorId}-${a.weekStart}`}
                className="border-b border-gray-100"
              >
                <td className="px-2 py-1">{a.workerName}</td>
                <td className="px-2 py-1">
                  <Link
                    href={`/c/${companyId}/time?${a.employeeId ? `employeeId=${a.employeeId}` : `vendorId=${a.vendorId}`}&date=${a.weekStart}`}
                    className="text-brand-700 hover:underline"
                  >
                    {formatDate(a.weekStart)} – {formatDate(addDays(a.weekStart, 6))}
                  </Link>
                </td>
                <td className="px-2 py-1 text-right tabular-nums">{a.hours}</td>
                <td className="px-2 py-1 text-right tabular-nums">{a.billableHours}</td>
                <td className="px-2 py-1 text-right">
                  <div className="flex justify-end gap-2">
                    <Button type="button" size="sm" onClick={() => decide(a, 'approve')}>
                      Approve
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => decide(a, 'reject')}
                    >
                      Reject
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
