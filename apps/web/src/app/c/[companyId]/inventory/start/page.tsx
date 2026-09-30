'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { todayIso } from '@acct/shared';
import { useClosingPassword } from '@/components/ledger/closing-password';
import { AccountSelect } from '@/components/ledger/pickers';
import { useSalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Button, Spinner } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { ledgerKeys } from '@/lib/queries';

const inputClass = 'block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm';

/**
 * Converts non-inventory items to inventory from a start date (the QuickBooks cut-over): each
 * item's quantity and value on that date, from QuickBooks' Inventory Valuation Summary.
 */
export default function StartTrackingPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const { ready, lookups } = useSalesLookups(companyId);
  const closing = useClosingPassword();
  const [startDate, setStartDate] = useState(todayIso());
  const [inBooks, setInBooks] = useState(true);
  const [offsetAccountId, setOffset] = useState('');
  const [rows, setRows] = useState<
    Record<string, { on: boolean; quantity: string; value: string }>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  if (!ready) return <Spinner />;
  const candidates = lookups.items.filter((i) => i.itemType === 'non_inventory' && i.isActive);
  const row = (id: string) => rows[id] ?? { on: false, quantity: '', value: '' };
  const set = (id: string, patch: Partial<{ on: boolean; quantity: string; value: string }>) =>
    setRows((r) => ({ ...r, [id]: { ...row(id), ...patch } }));

  async function save() {
    setError(null);
    setPending(true);
    try {
      await closing.run(async (closingPassword) => {
        await api(`/companies/${companyId}/inventory/start-tracking`, {
          method: 'POST',
          body: {
            startDate,
            offsetAccountId: inBooks ? null : offsetAccountId || null,
            lines: candidates
              .filter((i) => row(i.id).on)
              .map((i) => ({ itemId: i.id, quantity: row(i.id).quantity, value: row(i.id).value })),
            closingPassword,
          },
        });
        await Promise.all(ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })));
        router.push(`/c/${companyId}/inventory`);
      });
    } catch (err) {
      setError(
        err instanceof ApiError && err.errors.length
          ? err.errors.map((e) => e.message).join(' ')
          : errorMessage(err),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="space-y-5"
    >
      <h2 className="text-xl font-semibold text-gray-900">Start tracking inventory</h2>
      <p className="max-w-3xl text-sm text-gray-600">
        Turn non-inventory items into inventory from a date on, with the quantity and value each had
        on that date. After a QuickBooks import, use QuickBooks&apos; Inventory Valuation Summary
        for that date. Transactions before the date stay as they are.
      </p>
      {error && <Alert>{error}</Alert>}
      <div className="grid max-w-3xl gap-4 md:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">Start date</span>
          <input
            type="date"
            aria-label="Start date"
            required
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className={inputClass}
          />
        </label>
      </div>
      <fieldset className="max-w-3xl space-y-2 text-sm">
        <legend className="mb-1 font-medium text-gray-700">The value on hand</legend>
        <label className="flex items-start gap-2">
          <input type="radio" checked={inBooks} onChange={() => setInBooks(true)} />
          <span>
            Is already in my books (brought over from QuickBooks in Inventory Asset). Nothing is
            posted.
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input type="radio" checked={!inBooks} onChange={() => setInBooks(false)} />
          <span>Isn&apos;t in my books yet: post it against an account</span>
        </label>
        {!inBooks && (
          <div className="max-w-sm pl-6">
            <AccountSelect
              aria-label="Offset account"
              accounts={lookups.accounts}
              useNumbers={lookups.useNumbers}
              value={offsetAccountId}
              onChange={(e) => setOffset(e.target.value)}
            />
          </div>
        )}
      </fieldset>
      {candidates.length === 0 ? (
        <p className="text-sm text-gray-600">There are no non-inventory items to convert.</p>
      ) : (
        <table className="w-full max-w-3xl text-sm" data-testid="start-tracking-items">
          <thead>
            <tr className="border-b border-gray-300 text-left text-xs uppercase tracking-wide text-gray-500">
              <th className="px-2 py-1">Track</th>
              <th className="px-2 py-1">Item</th>
              <th className="px-2 py-1 text-right">Quantity on hand</th>
              <th className="px-2 py-1 text-right">Total value</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((i) => (
              <tr key={i.id} className="border-b border-gray-100">
                <td className="px-2 py-1">
                  <input
                    type="checkbox"
                    aria-label={`Track ${i.name}`}
                    checked={row(i.id).on}
                    onChange={(e) => set(i.id, { on: e.target.checked })}
                  />
                </td>
                <td className="px-2 py-1">{i.name}</td>
                <td className="px-2 py-1">
                  <input
                    aria-label={`${i.name} quantity`}
                    inputMode="decimal"
                    disabled={!row(i.id).on}
                    value={row(i.id).quantity}
                    onChange={(e) => set(i.id, { quantity: e.target.value })}
                    className={`${inputClass} text-right tabular-nums disabled:bg-gray-50`}
                  />
                </td>
                <td className="px-2 py-1">
                  <input
                    aria-label={`${i.name} value`}
                    inputMode="decimal"
                    disabled={!row(i.id).on}
                    value={row(i.id).value}
                    onChange={(e) => set(i.id, { value: e.target.value })}
                    className={`${inputClass} text-right tabular-nums disabled:bg-gray-50`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex max-w-3xl justify-end border-t border-gray-200 pt-4">
        <Button type="submit" loading={pending} disabled={!candidates.some((i) => row(i.id).on)}>
          Start tracking
        </Button>
      </div>
      {closing.dialog}
    </form>
  );
}
