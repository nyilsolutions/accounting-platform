'use client';

import { useState, type ReactNode } from 'react';
import {
  formatMoney,
  isStocked,
  parseMoney,
  todayIso,
  tryParseMoney,
  type InventoryAdjustmentDto,
  type InventoryAdjustmentInput,
} from '@acct/shared';
import { AccountSelect } from '@/components/ledger/pickers';
import type { SalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Button } from '@/components/ui';
import { ApiError } from '@/lib/api';

const inputClass = 'block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm';

interface Line {
  itemId: string;
  /** What the user typed: the new quantity, or the change. */
  newQty: string;
  change: string;
  unitCost: string;
}

/** Every error, with the line it belongs to. */
function errorList(error: ApiError | string | null): string[] {
  if (!error) return [];
  if (typeof error === 'string') return [error];
  const lines = error.errors.map((e) => {
    const m = /^lines\.(\d+)\./.exec(e.path);
    return m ? `Line ${Number(m[1]) + 1}: ${e.message}` : e.message;
  });
  return lines.length ? lines : [error.message];
}

/**
 * Inventory quantity adjustment: for each item, the new quantity on hand (or the change). Added
 * stock can be given a cost per unit; otherwise it comes in at the item's current cost. Removed
 * stock goes out at cost to the adjustment account.
 */
export function AdjustmentForm({
  initial,
  lookups,
  readOnly,
  onSave,
  footer,
}: {
  initial?: InventoryAdjustmentDto;
  lookups: SalesLookups;
  readOnly?: boolean;
  onSave: (input: InventoryAdjustmentInput) => Promise<void>;
  footer?: ReactNode;
}) {
  const stocked = lookups.items.filter((i) => isStocked(i.itemType));
  const onHandOf = (id: string) => stocked.find((i) => i.id === id)?.quantityOnHand ?? '0';
  const defaultAccount =
    lookups.accounts.find((a) => a.name === 'Inventory Shrinkage' && a.isActive)?.id ??
    lookups.accounts.find((a) => a.accountType === 'cost_of_goods_sold' && a.isActive)?.id ??
    '';
  const [txnDate, setTxnDate] = useState(initial?.txnDate ?? todayIso());
  const [number, setNumber] = useState(initial?.number ?? '');
  const [memo, setMemo] = useState(initial?.memo ?? '');
  const [accountId, setAccountId] = useState(initial?.accountId ?? defaultAccount);
  const [lines, setLines] = useState<Line[]>(
    initial
      ? initial.lines.map((l) => ({
          itemId: l.itemId,
          change: l.quantityChange,
          newQty: '',
          unitCost: l.unitCost ?? '',
        }))
      : [{ itemId: '', change: '', newQty: '', unitCost: '' }],
  );
  const [error, setError] = useState<ApiError | string | null>(null);
  const [pending, setPending] = useState(false);
  const set = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function save() {
    setError(null);
    setPending(true);
    try {
      await onSave({
        txnDate,
        number,
        memo,
        accountId,
        lines: lines
          .filter((l) => l.itemId)
          .map((l) => ({ itemId: l.itemId, quantityChange: l.change, unitCost: l.unitCost })),
        version: initial?.version,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err : String(err));
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
      {errorList(error).length > 0 && <Alert>{errorList(error).join(' ')}</Alert>}
      <fieldset disabled={readOnly} className="space-y-5">
        <div className="grid max-w-3xl gap-4 md:grid-cols-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Adjustment date</span>
            <input
              type="date"
              aria-label="Adjustment date"
              required
              value={txnDate}
              onChange={(e) => setTxnDate(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Reference no.</span>
            <input
              aria-label="Reference no."
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Adjustment account</span>
            <AccountSelect
              aria-label="Adjustment account"
              accounts={lookups.accounts}
              useNumbers={lookups.useNumbers}
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            />
          </label>
        </div>
        <table className="w-full text-sm" data-testid="adjustment-lines">
          <thead>
            <tr className="border-b border-gray-300 text-left text-xs uppercase tracking-wide text-gray-500">
              <th className="px-2 py-1">#</th>
              <th className="px-2 py-1">Product</th>
              <th className="px-2 py-1 text-right">Qty on hand</th>
              <th className="px-2 py-1 text-right">New qty</th>
              <th className="px-2 py-1 text-right">Change in qty</th>
              <th className="px-2 py-1 text-right">Cost per unit (added)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const onHand = l.itemId ? onHandOf(l.itemId) : '';
              const adding = tryParseMoney(l.change) !== null && parseMoney(l.change) > 0n;
              return (
                <tr key={i} className="border-b border-gray-100">
                  <td className="px-2 py-1 text-gray-500">{i + 1}</td>
                  <td className="px-2 py-1">
                    <select
                      aria-label={`Product ${i + 1}`}
                      value={l.itemId}
                      onChange={(e) => set(i, { itemId: e.target.value })}
                      className={inputClass}
                    >
                      <option value="">—</option>
                      {stocked.map((it) => (
                        <option key={it.id} value={it.id}>
                          {it.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">{onHand}</td>
                  <td className="px-2 py-1">
                    <input
                      aria-label={`New quantity ${i + 1}`}
                      inputMode="decimal"
                      value={l.newQty}
                      onChange={(e) => {
                        const v = e.target.value;
                        const n = tryParseMoney(v);
                        const oh = tryParseMoney(onHand || '0') ?? 0n;
                        set(i, {
                          newQty: v,
                          change: n === null ? l.change : qtyText(n - oh),
                        });
                      }}
                      className={`${inputClass} text-right tabular-nums`}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      aria-label={`Change in quantity ${i + 1}`}
                      inputMode="decimal"
                      value={l.change}
                      onChange={(e) => set(i, { change: e.target.value, newQty: '' })}
                      className={`${inputClass} text-right tabular-nums`}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      aria-label={`Cost per unit ${i + 1}`}
                      inputMode="decimal"
                      value={l.unitCost}
                      disabled={!adding}
                      placeholder={adding ? 'Current cost' : ''}
                      onChange={(e) => set(i, { unitCost: e.target.value })}
                      className={`${inputClass} text-right tabular-nums disabled:bg-gray-50`}
                    />
                  </td>
                  <td className="px-2 py-1 text-right">
                    {!readOnly && lines.length > 1 && (
                      <button
                        type="button"
                        className="text-gray-400 hover:text-red-600"
                        aria-label={`Remove line ${i + 1}`}
                        onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!readOnly && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() =>
              setLines((ls) => [...ls, { itemId: '', change: '', newQty: '', unitCost: '' }])
            }
          >
            Add line
          </Button>
        )}
        <label className="block max-w-3xl text-sm">
          <span className="mb-1 block font-medium text-gray-700">Memo</span>
          <textarea
            aria-label="Memo"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            rows={2}
            className={inputClass}
          />
        </label>
      </fieldset>
      {initial && (
        <p className="text-sm text-gray-700">
          Value of this adjustment: <strong>{formatMoney(initial.total)}</strong>
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 pt-4">
        <div>{footer}</div>
        {!readOnly && (
          <Button type="submit" loading={pending}>
            Save and close
          </Button>
        )}
      </div>
    </form>
  );
}

function qtyText(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / 10_000n;
  const frac = (abs % 10_000n).toString().padStart(4, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
