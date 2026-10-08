'use client';

import { useState } from 'react';
import { formatDate, formatMoney, type TimeEntryDto } from '@acct/shared';
import { Alert, Button, Dialog, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { emptyLine, type LineState } from './sales-lines';

/**
 * "Add billable time" on invoices and sales receipts (ADR 0019): the customer's approved,
 * billable time not billed yet. Each chosen entry becomes a line (hours × rate) that remembers the
 * time it bills.
 */
export function BillableTime({
  companyId,
  customerId,
  onFile,
  onAdd,
}: {
  companyId: string;
  customerId: string;
  /** Time already on this document's lines. */
  onFile: string[];
  onAdd: (lines: LineState[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<TimeEntryDto[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  async function show() {
    setOpen(true);
    setEntries(null);
    setError(null);
    try {
      const list = await api<TimeEntryDto[]>(
        `/companies/${companyId}/time/entries?unbilled=true&customerId=${customerId}`,
      );
      const available = list.filter((e) => !onFile.includes(e.id));
      setEntries(available);
      setChosen(new Set(available.map((e) => e.id)));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function add() {
    const lines = (entries ?? [])
      .filter((e) => chosen.has(e.id))
      .map((e) => ({
        ...emptyLine(),
        product: e.itemId ? `i:${e.itemId}` : '',
        description: [e.itemName, `${e.workerName}, ${formatDate(e.workDate)}`, e.notes]
          .filter(Boolean)
          .join(': '),
        quantity: e.hours,
        rate: e.billingRate ?? '',
        amount: e.amount ?? '',
        serviceDate: e.workDate,
        classId: e.classId ?? '',
        timeEntryIds: [e.id],
      }));
    onAdd(lines);
    setOpen(false);
  }

  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={show}>
        Add billable time
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Add billable time" wide>
        {error && <Alert>{error}</Alert>}
        {!entries && !error ? (
          <Spinner />
        ) : entries && entries.length === 0 ? (
          <p className="text-sm text-gray-600">
            This customer has no approved, billable time to bill.
          </p>
        ) : entries ? (
          <div className="space-y-4">
            <table className="w-full text-sm" data-testid="billable-time">
              <thead>
                <tr className="border-b border-gray-300 text-left text-xs uppercase tracking-wide text-gray-500">
                  <th className="px-2 py-1" />
                  <th className="px-2 py-1">Date</th>
                  <th className="px-2 py-1">Who</th>
                  <th className="px-2 py-1">Service</th>
                  <th className="px-2 py-1 text-right">Hours</th>
                  <th className="px-2 py-1 text-right">Rate</th>
                  <th className="px-2 py-1 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="border-b border-gray-100">
                    <td className="px-2 py-1">
                      <input
                        type="checkbox"
                        aria-label={`Bill ${e.workerName} ${e.workDate}`}
                        checked={chosen.has(e.id)}
                        onChange={(ev) =>
                          setChosen((c) => {
                            const n = new Set(c);
                            if (ev.target.checked) n.add(e.id);
                            else n.delete(e.id);
                            return n;
                          })
                        }
                      />
                    </td>
                    <td className="px-2 py-1">{formatDate(e.workDate)}</td>
                    <td className="px-2 py-1">{e.workerName}</td>
                    <td className="px-2 py-1">{e.itemName}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{e.hours}</td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {e.billingRate ? formatMoney(e.billingRate) : ''}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {e.amount ? formatMoney(e.amount) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={add} disabled={chosen.size === 0}>
                Add {chosen.size} to the invoice
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
