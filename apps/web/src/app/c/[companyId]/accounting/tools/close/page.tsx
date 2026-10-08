'use client';

import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addDays,
  formatDate,
  monthEndOf,
  monthStartOf,
  todayIso,
  type CloseChecklistDto,
  type CloseStepDto,
} from '@acct/shared';
import { Alert, Badge, Button, Card, Spinner, TextInput } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, useAccess } from '@/lib/queries';

const STATUS: Record<CloseStepDto['status'], { text: string; tone: 'green' | 'amber' | 'gray' }> = {
  done: { text: 'Done', tone: 'green' },
  attention: { text: 'Needs attention', tone: 'amber' },
  not_needed: { text: 'Not needed', tone: 'gray' },
};

/** Accountant tools › Close the books: the month-end checklist (ADR 0021). */
export default function ClosePage() {
  const { companyId } = useParams<{ companyId: string }>();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const canManage = access.can('ledger.manage');
  // Last month by default.
  const [periodEnd, setPeriodEnd] = useState(() => addDays(monthStartOf(todayIso()), -1));
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const path = `/companies/${companyId}/accountant/close/${periodEnd}`;
  const q = useQuery({
    queryKey: [...keys.accountant(companyId), 'close', periodEnd],
    queryFn: () => api<CloseChecklistDto>(path),
  });

  async function act(fn: () => Promise<CloseChecklistDto>, message: string) {
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      const r = await fn();
      qc.setQueryData([...keys.accountant(companyId), 'close', periodEnd], r);
      setNotice(message);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setPending(false);
    }
  }

  async function close(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const body = {
      note: String(f.get('note') ?? '') || undefined,
      closingPassword: String(f.get('closingPassword') ?? '') || undefined,
      currentClosingPassword: String(f.get('currentClosingPassword') ?? '') || undefined,
    };
    const ok = await act(
      () => api<CloseChecklistDto>(path, { method: 'POST', body }),
      `The books are closed through ${formatDate(periodEnd)}.`,
    );
    if (ok) {
      form.reset();
      await qc.invalidateQueries({ queryKey: keys.ledgerSettings(companyId) });
    }
  }

  const list = q.data;
  const closed = !!list?.closingDate && list.closingDate >= periodEnd;
  return (
    <div className="space-y-4" data-testid="close-books">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Close the books</h2>
          <p className="text-sm text-gray-600">
            {list?.closingDate
              ? `Closed through ${formatDate(list.closingDate)}.`
              : 'No closing date yet.'}
          </p>
        </div>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-gray-700">Month</span>
          <input
            type="month"
            aria-label="Month to close"
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            value={periodEnd.slice(0, 7)}
            onChange={(e) => e.target.value && setPeriodEnd(monthEndOf(`${e.target.value}-01`))}
          />
        </label>
      </div>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {q.isPending ? (
        <Spinner />
      ) : !list ? (
        <Alert>{errorMessage(q.error)}</Alert>
      ) : (
        <>
          <Card className="divide-y divide-gray-100" data-testid="close-checklist">
            {list.steps.map((s) => (
              <div key={s.step} className="flex flex-wrap items-start gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{s.label}</span>
                    <Badge tone={STATUS[s.status].tone}>{STATUS[s.status].text}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-gray-600">{s.detail}</p>
                  {s.markedBy && (
                    <p className="mt-1 text-sm text-gray-700">
                      Marked done by {s.markedBy}: <em>{s.note}</em>
                    </p>
                  )}
                </div>
                {canManage && !closed && (
                  <div className="flex items-center gap-2">
                    {s.markedBy ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={pending}
                        onClick={() =>
                          act(
                            () =>
                              api<CloseChecklistDto>(`${path}/marks/${s.step}`, {
                                method: 'DELETE',
                              }),
                            `“${s.label}” is no longer marked done.`,
                          )
                        }
                      >
                        Unmark
                      </Button>
                    ) : (
                      s.status === 'attention' && (
                        <>
                          <input
                            aria-label={`Note for ${s.label}`}
                            placeholder="Why it's done"
                            className="w-56 rounded-md border border-gray-300 px-2 py-1 text-sm"
                            value={notes[s.step] ?? ''}
                            onChange={(e) => setNotes({ ...notes, [s.step]: e.target.value })}
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            disabled={pending || !(notes[s.step] ?? '').trim()}
                            onClick={() =>
                              act(
                                () =>
                                  api<CloseChecklistDto>(`${path}/marks`, {
                                    method: 'PUT',
                                    body: { step: s.step, note: notes[s.step] },
                                  }),
                                `“${s.label}” is marked done.`,
                              )
                            }
                          >
                            Mark done
                          </Button>
                        </>
                      )
                    )}
                  </div>
                )}
              </div>
            ))}
          </Card>

          {canManage && !closed && (
            <Card className="p-4">
              <form onSubmit={close} className="grid gap-3 md:grid-cols-4 md:items-end">
                <TextInput label="Note (optional)" name="note" />
                {list.hasClosingPassword ? (
                  <TextInput
                    label="Current closing password"
                    name="currentClosingPassword"
                    type="password"
                    autoComplete="off"
                  />
                ) : (
                  <TextInput
                    label="Closing password (new)"
                    name="closingPassword"
                    type="password"
                    autoComplete="new-password"
                    hint="At least 8 characters. Needed to change anything on or before the closing date."
                  />
                )}
                <div className="md:col-span-2">
                  <Button type="submit" disabled={pending || !list.ready}>
                    Close {formatDate(list.periodStart)} – {formatDate(list.periodEnd)}
                  </Button>
                  {!list.ready && (
                    <p className="mt-1 text-xs text-gray-500">
                      Finish or mark done every step first.
                    </p>
                  )}
                </div>
              </form>
            </Card>
          )}

          {list.closes.length > 0 && (
            <Card className="p-4">
              <h3 className="mb-2 font-medium">Closes</h3>
              <ul className="space-y-1 text-sm" data-testid="closes">
                {list.closes.map((c) => (
                  <li key={c.id}>
                    Through {formatDate(c.periodEnd)}, by {c.closedBy ?? 'someone'} on{' '}
                    {formatDate(c.closedAt.slice(0, 10))}
                    {c.note && ` — ${c.note}`}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
