'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addDays,
  formatDate,
  moneyToString,
  parseHours,
  parseMoney,
  TIME_STATUS_LABELS,
  todayIso,
  weekOf,
  type TimeChoicesDto,
  type TimeEntryDto,
  type TimesheetDto,
} from '@acct/shared';
import { Alert, Badge, Button, Spinner } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { keys, useAccess } from '@/lib/queries';

const cell = 'block w-full rounded-md border border-gray-300 px-2 py-1 text-sm';
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface Row {
  key: number;
  customerId: string;
  itemId: string;
  payrollItemId: string;
  billable: boolean;
  notes: string;
  hours: string[];
}
/** Hours (1/10,000 units) without trailing zeros. */
function hoursText(v: bigint): string {
  const t = moneyToString(v, 4).replace(/\.?0+$/, '');
  return t === '' ? '0' : t;
}

let nextKey = 1;
const emptyRow = (): Row => ({
  key: nextKey++,
  customerId: '',
  itemId: '',
  payrollItemId: '',
  billable: false,
  notes: '',
  hours: ['', '', '', '', '', '', ''],
});

/** Open and rejected entries as editable rows, one per activity. */
function rowsFrom(week: TimesheetDto): Row[] {
  const rows = new Map<string, Row>();
  for (const e of week.entries.filter((x) => x.status === 'open' || x.status === 'rejected')) {
    const key = [e.customerId, e.itemId, e.payrollItemId, e.billable, e.notes].join('|');
    let r = rows.get(key);
    if (!r) {
      r = {
        ...emptyRow(),
        customerId: e.customerId ?? '',
        itemId: e.itemId ?? '',
        payrollItemId: e.payrollItemId ?? '',
        billable: e.billable,
        notes: e.notes ?? '',
      };
      rows.set(key, r);
    }
    const day = [0, 1, 2, 3, 4, 5, 6].findIndex((i) => addDays(week.weekStart, i) === e.workDate);
    const prev = r.hours[day] ? parseMoney(r.hours[day]!) : 0n;
    r.hours[day] = hoursText(prev + parseMoney(e.hours));
  }
  return [...rows.values()];
}

function Timesheet() {
  const { companyId } = useParams<{ companyId: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const choices = useQuery({
    queryKey: [...keys.time(companyId), 'choices'],
    queryFn: () => api<TimeChoicesDto>(`/companies/${companyId}/time/choices`),
  });
  const paramWorker = params.get('employeeId')
    ? `e:${params.get('employeeId')}`
    : params.get('vendorId')
      ? `v:${params.get('vendorId')}`
      : '';
  const [worker, setWorker] = useState(paramWorker);
  const [weekStart, setWeekStart] = useState(weekOf(params.get('date') ?? todayIso()).start);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<ApiError | string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const first = choices.data?.workers[0];
  const current =
    worker || (first ? (first.employeeId ? `e:${first.employeeId}` : `v:${first.vendorId}`) : '');
  const who: Record<string, string> | null = current.startsWith('e:')
    ? { employeeId: current.slice(2) }
    : current
      ? { vendorId: current.slice(2) }
      : null;
  const week = useQuery({
    queryKey: [...keys.time(companyId), 'week', current, weekStart],
    enabled: !!who,
    queryFn: () =>
      api<TimesheetDto>(
        `/companies/${companyId}/time/timesheet?${new URLSearchParams({ ...who!, date: weekStart })}`,
      ),
  });
  useEffect(() => {
    if (week.data) {
      const r = rowsFrom(week.data);
      setRows(r.length ? r : [emptyRow()]);
    }
  }, [week.data]);

  if (choices.isError) return <Alert>{errorMessage(choices.error)}</Alert>;
  if (choices.isPending) return <Spinner />;
  const c = choices.data;
  if (c.workers.length === 0)
    return <p className="text-sm text-gray-600">Add employees or vendors to track their time.</p>;
  const isEmployee = current.startsWith('e:');
  const locked: TimeEntryDto[] = (week.data?.entries ?? []).filter(
    (e) => e.status === 'submitted' || e.status === 'approved',
  );
  const rejected = (week.data?.entries ?? []).filter((e) => e.status === 'rejected');
  const canEdit = access.can('time.manage');
  const set = (key: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const dayTotal = (d: number) =>
    rows.reduce((s, r) => {
      const h = r.hours[d] ? parseHours(r.hours[d]!) : null;
      return s + (h ? parseMoney(h) : 0n);
    }, 0n) +
    locked
      .filter((e) => e.workDate === addDays(weekStart, d))
      .reduce((s, e) => s + parseMoney(e.hours), 0n);
  const fmt = hoursText;

  async function act(fn: () => Promise<string>) {
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      setNotice(await fn());
      await qc.invalidateQueries({ queryKey: keys.time(companyId) });
    } catch (err) {
      setError(err instanceof ApiError ? err : errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  const save = () =>
    api(`/companies/${companyId}/time/timesheet`, {
      method: 'PUT',
      body: {
        ...who,
        weekStart,
        rows: rows
          .filter((r) => r.hours.some((h) => h.trim()))
          .map((r) => ({
            customerId: r.customerId || null,
            itemId: r.itemId || null,
            payrollItemId: isEmployee ? r.payrollItemId || null : null,
            billable: r.billable,
            notes: r.notes,
            hours: r.hours,
          })),
      },
    });
  const errorText =
    error instanceof ApiError
      ? error.errors.length
        ? error.errors.map((e) => e.message).join(' ')
        : error.message
      : error;
  const go = (w: string, start: string) => {
    setWorker(w);
    setWeekStart(start);
    const [kind, id] = [w.slice(0, 1), w.slice(2)];
    router.replace(
      `/c/${companyId}/time?${kind === 'e' ? 'employeeId' : 'vendorId'}=${id}&date=${start}`,
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">Whose time</span>
          <select
            aria-label="Whose time"
            value={current}
            onChange={(e) => go(e.target.value, weekStart)}
            className={cell}
          >
            <optgroup label="Employees">
              {c.workers
                .filter((w) => w.employeeId)
                .map((w) => (
                  <option key={w.employeeId} value={`e:${w.employeeId}`}>
                    {w.name}
                  </option>
                ))}
            </optgroup>
            <optgroup label="Vendors (contractors)">
              {c.workers
                .filter((w) => w.vendorId)
                .map((w) => (
                  <option key={w.vendorId} value={`v:${w.vendorId}`}>
                    {w.name}
                  </option>
                ))}
            </optgroup>
          </select>
        </label>
        <div className="flex items-end gap-1 text-sm">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-label="Previous week"
            onClick={() => go(current, addDays(weekStart, -7))}
          >
            ←
          </Button>
          <label className="block">
            <span className="mb-1 block font-medium text-gray-700">Week of</span>
            <input
              type="date"
              aria-label="Week of"
              value={weekStart}
              onChange={(e) => e.target.value && go(current, weekOf(e.target.value).start)}
              className={cell}
            />
          </label>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-label="Next week"
            onClick={() => go(current, addDays(weekStart, 7))}
          >
            →
          </Button>
        </div>
      </div>
      {errorText && <Alert>{errorText}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {rejected.length > 0 && (
        <Alert>
          Rejected: {[...new Set(rejected.map((e) => e.rejectionNote))].join('; ')}. Fix the time
          and submit it again.
        </Alert>
      )}
      {week.isPending && who ? (
        <Spinner />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[60rem] text-sm" data-testid="timesheet">
              <thead>
                <tr className="border-b border-gray-300 text-left text-xs uppercase tracking-wide text-gray-500">
                  <th className="px-1 py-1">Customer</th>
                  <th className="px-1 py-1">Service</th>
                  {isEmployee && <th className="px-1 py-1">Pay as</th>}
                  <th className="px-1 py-1">Billable</th>
                  {DAYS.map((d, i) => (
                    <th key={d} className="w-16 px-1 py-1 text-right">
                      {d} {formatDate(addDays(weekStart, i)).slice(0, 5)}
                    </th>
                  ))}
                  <th className="px-1 py-1">Notes</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, n) => (
                  <tr key={r.key} className="border-b border-gray-100">
                    <td className="px-1 py-1">
                      <select
                        aria-label={`Row ${n + 1} customer`}
                        disabled={!canEdit}
                        value={r.customerId}
                        onChange={(e) =>
                          set(r.key, {
                            customerId: e.target.value,
                            billable: e.target.value ? r.billable : false,
                          })
                        }
                        className={cell}
                      >
                        <option value="">—</option>
                        {c.customers.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-1 py-1">
                      <select
                        aria-label={`Row ${n + 1} service`}
                        disabled={!canEdit}
                        value={r.itemId}
                        onChange={(e) => set(r.key, { itemId: e.target.value })}
                        className={cell}
                      >
                        <option value="">—</option>
                        {c.services.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    {isEmployee && (
                      <td className="px-1 py-1">
                        <select
                          aria-label={`Row ${n + 1} pay as`}
                          disabled={!canEdit}
                          value={r.payrollItemId}
                          onChange={(e) => set(r.key, { payrollItemId: e.target.value })}
                          className={cell}
                        >
                          <option value="">Regular</option>
                          {c.payrollItems
                            .filter((p) => p.kind !== 'hourly')
                            .map((x) => (
                              <option key={x.id} value={x.id}>
                                {x.name}
                              </option>
                            ))}
                        </select>
                      </td>
                    )}
                    <td className="px-1 py-1 text-center">
                      <input
                        type="checkbox"
                        aria-label={`Row ${n + 1} billable`}
                        disabled={!canEdit || !r.customerId}
                        checked={r.billable}
                        onChange={(e) => set(r.key, { billable: e.target.checked })}
                      />
                    </td>
                    {r.hours.map((h, d) => (
                      <td key={d} className="px-1 py-1">
                        <input
                          aria-label={`Row ${n + 1} ${DAYS[d]}`}
                          inputMode="decimal"
                          disabled={!canEdit}
                          value={h}
                          onChange={(e) =>
                            set(r.key, {
                              hours: r.hours.map((x, j) => (j === d ? e.target.value : x)),
                            })
                          }
                          className={`${cell} text-right tabular-nums`}
                        />
                      </td>
                    ))}
                    <td className="px-1 py-1">
                      <input
                        aria-label={`Row ${n + 1} notes`}
                        disabled={!canEdit}
                        value={r.notes}
                        onChange={(e) => set(r.key, { notes: e.target.value })}
                        className={cell}
                      />
                    </td>
                    <td className="px-1 py-1 text-right">
                      {canEdit && (
                        <button
                          type="button"
                          aria-label={`Remove row ${n + 1}`}
                          className="text-gray-400 hover:text-red-600"
                          onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                        >
                          ×
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {locked.map((e) => (
                  <tr key={e.id} className="border-b border-gray-100 bg-gray-50 text-gray-600">
                    <td className="px-2 py-1">{e.customerName}</td>
                    <td className="px-2 py-1">{e.itemName}</td>
                    {isEmployee && <td className="px-2 py-1">{e.payrollItemName ?? 'Regular'}</td>}
                    <td className="px-2 py-1 text-center">{e.billable ? '✓' : ''}</td>
                    {DAYS.map((d, i) => (
                      <td key={d} className="px-2 py-1 text-right tabular-nums">
                        {e.workDate === addDays(weekStart, i) ? e.hours : ''}
                      </td>
                    ))}
                    <td className="px-2 py-1" colSpan={2}>
                      <Badge tone={e.status === 'approved' ? 'green' : 'amber'}>
                        {TIME_STATUS_LABELS[e.status]}
                      </Badge>{' '}
                      {e.invoiceNumber ? `Billed on invoice ${e.invoiceNumber}` : ''}
                      {e.paycheckId ? ' Paid' : ''}
                    </td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="px-2 py-1" colSpan={isEmployee ? 4 : 3}>
                    Total
                  </td>
                  {DAYS.map((d, i) => (
                    <td key={d} className="px-2 py-1 text-right tabular-nums">
                      {fmt(dayTotal(i))}
                    </td>
                  ))}
                  <td className="px-2 py-1" data-testid="week-total">
                    {fmt(DAYS.reduce((s, _, i) => s + dayTotal(i), 0n))} hours
                  </td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
          {canEdit && (
            <div className="flex flex-wrap justify-between gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setRows((rs) => [...rs, emptyRow()])}
              >
                Add row
              </Button>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  loading={pending}
                  onClick={() =>
                    act(async () => {
                      await save();
                      return 'Timesheet saved.';
                    })
                  }
                >
                  Save
                </Button>
                <Button
                  type="button"
                  loading={pending}
                  onClick={() =>
                    act(async () => {
                      await save();
                      await api(`/companies/${companyId}/time/submit`, {
                        method: 'POST',
                        body: { ...who, weekStart },
                      });
                      return 'Submitted for approval.';
                    })
                  }
                >
                  Submit for approval
                </Button>
              </div>
            </div>
          )}
          {week.data?.canApprove && locked.some((e) => e.status === 'submitted') && (
            <div className="flex justify-end">
              <Button
                type="button"
                onClick={() =>
                  act(async () => {
                    await api(`/companies/${companyId}/time/approve`, {
                      method: 'POST',
                      body: {
                        entryIds: locked.filter((e) => e.status === 'submitted').map((e) => e.id),
                      },
                    });
                    return 'Time approved.';
                  })
                }
              >
                Approve this week
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function TimePage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Timesheet />
    </Suspense>
  );
}
