'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addDays,
  formatDate,
  moneyToString,
  parseMoney,
  todayIso,
  weekOf,
  type TimesheetDto,
} from '@acct/shared';
import { portalApi, usePortalLink } from '@/components/portal/portal-context';
import { Alert, Badge, Button, Card, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

interface Row {
  key: number;
  notes: string;
  hours: string[];
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const STATUS: Record<string, { label: string; tone: 'gray' | 'amber' | 'green' | 'red' }> = {
  open: { label: 'Not submitted', tone: 'gray' },
  submitted: { label: 'Waiting for approval', tone: 'amber' },
  approved: { label: 'Approved', tone: 'green' },
  rejected: { label: 'Sent back', tone: 'red' },
};

let next = 1;
const blank = (): Row => ({ key: next++, notes: '', hours: ['', '', '', '', '', '', ''] });

/** Editable rows from the week's open and sent-back time: one row per note. */
function rowsOf(week: TimesheetDto): Row[] {
  const rows = new Map<string, Row>();
  for (const e of week.entries.filter((x) => x.status === 'open' || x.status === 'rejected')) {
    const notes = e.notes ?? '';
    const row = rows.get(notes) ?? { key: next++, notes, hours: ['', '', '', '', '', '', ''] };
    const day = DAYS.findIndex((_, i) => addDays(week.weekStart, i) === e.workDate);
    if (day >= 0) {
      const prev = row.hours[day] ? parseMoney(row.hours[day]!) : 0n;
      const sum = prev + parseMoney(e.hours);
      row.hours[day] = moneyToString(sum, 2).replace(/\.?0+$/, '');
    }
    rows.set(notes, row);
  }
  return rows.size ? [...rows.values()] : [blank()];
}

/** The person's own weekly timesheet: enter hours, save, submit for approval. */
export default function PortalTimePage() {
  const link = usePortalLink();
  const qc = useQueryClient();
  const [weekStart, setWeekStart] = useState(weekOf(todayIso()).start);
  const [rows, setRows] = useState<Row[]>([blank()]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = ['portal', link.companyId, 'timesheet', weekStart];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<TimesheetDto>(portalApi(link.companyId, `/timesheet?date=${weekStart}`)),
  });
  useEffect(() => {
    if (q.data) setRows(rowsOf(q.data));
  }, [q.data]);

  async function act(fn: () => Promise<TimesheetDto>, message: string) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const week = await fn();
      qc.setQueryData(key, week);
      setNotice(message);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const save = () =>
    api<TimesheetDto>(portalApi(link.companyId, '/timesheet'), {
      method: 'PUT',
      body: {
        weekStart,
        rows: rows
          .filter((r) => r.hours.some((h) => h.trim()))
          .map((r) => ({ notes: r.notes || undefined, hours: r.hours })),
      },
    });

  const locked = (q.data?.entries ?? []).filter(
    (e) => e.status === 'submitted' || e.status === 'approved',
  );
  const sentBack = (q.data?.entries ?? []).find((e) => e.status === 'rejected');
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            aria-label="Previous week"
            onClick={() => setWeekStart(addDays(weekStart, -7))}
          >
            ←
          </Button>
          <span className="text-sm font-medium" data-testid="portal-week">
            Week of {formatDate(weekStart)}
          </span>
          <Button
            variant="secondary"
            size="sm"
            aria-label="Next week"
            onClick={() => setWeekStart(addDays(weekStart, 7))}
          >
            →
          </Button>
        </div>
        {q.data && <span className="text-sm text-gray-600">Total {q.data.total} hours</span>}
      </div>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {sentBack?.rejectionNote && <Alert kind="info">Sent back: {sentBack.rejectionNote}</Alert>}
      {q.isPending ? (
        <Spinner />
      ) : (
        <Card className="overflow-x-auto p-4">
          <table className="w-full min-w-[40rem] text-sm" data-testid="portal-timesheet">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="pb-2">What you worked on</th>
                {DAYS.map((d, i) => (
                  <th key={d} className="pb-2 text-center">
                    {d}
                    <div className="font-normal normal-case">
                      {addDays(weekStart, i).slice(5).replace('-', '/')}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={r.key}>
                  <td className="py-1 pr-2">
                    <input
                      aria-label={`Row ${ri + 1} notes`}
                      className="w-full rounded-md border border-gray-300 px-2 py-1"
                      value={r.notes}
                      onChange={(e) =>
                        setRows(
                          rows.map((x) => (x.key === r.key ? { ...x, notes: e.target.value } : x)),
                        )
                      }
                    />
                  </td>
                  {r.hours.map((h, d) => (
                    <td key={d} className="px-1 py-1">
                      <input
                        aria-label={`Row ${ri + 1} ${DAYS[d]} hours`}
                        inputMode="decimal"
                        className="w-14 rounded-md border border-gray-300 px-1 py-1 text-center"
                        value={h}
                        onChange={(e) =>
                          setRows(
                            rows.map((x) =>
                              x.key === r.key
                                ? {
                                    ...x,
                                    hours: x.hours.map((v, i) => (i === d ? e.target.value : v)),
                                  }
                                : x,
                            ),
                          )
                        }
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" onClick={() => setRows([...rows, blank()])}>
              Add a row
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => act(save, 'Saved.')}
            >
              Save
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  await save();
                  return api<TimesheetDto>(portalApi(link.companyId, '/timesheet/submit'), {
                    method: 'POST',
                    body: { weekStart },
                  });
                }, 'Submitted for approval.')
              }
            >
              Submit for approval
            </Button>
          </div>
        </Card>
      )}
      {locked.length > 0 && (
        <Card className="p-4 text-sm">
          <h3 className="mb-2 font-medium text-gray-900">Submitted time</h3>
          <ul className="space-y-1" data-testid="portal-submitted-time">
            {locked.map((e) => (
              <li key={e.id} className="flex justify-between gap-4">
                <span>
                  {formatDate(e.workDate)} · {e.hours} h{e.notes ? ` · ${e.notes}` : ''}
                </span>
                <Badge tone={STATUS[e.status]!.tone}>{STATUS[e.status]!.label}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
