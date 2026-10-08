'use client';

import { useState, type ReactNode } from 'react';
import {
  formatMoney,
  parseMoney,
  todayIso,
  tryParseMoney,
  type InventoryBuildDto,
  type InventoryBuildInput,
} from '@acct/shared';
import type { SalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Button } from '@/components/ui';
import { ApiError } from '@/lib/api';

const inputClass = 'block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm';

/**
 * Build assemblies: uses up the components on the build date and adds the assemblies at what the
 * components cost. Shows what each component needs against what's on hand.
 */
export function BuildForm({
  initial,
  lookups,
  readOnly,
  onSave,
  footer,
}: {
  initial?: InventoryBuildDto;
  lookups: SalesLookups;
  readOnly?: boolean;
  onSave: (input: InventoryBuildInput) => Promise<void>;
  footer?: ReactNode;
}) {
  const assemblies = lookups.items.filter((i) => i.itemType === 'assembly');
  const [assemblyId, setAssemblyId] = useState(initial?.assemblyId ?? assemblies[0]?.id ?? '');
  const [quantity, setQuantity] = useState(initial?.quantity ?? '1');
  const [txnDate, setTxnDate] = useState(initial?.txnDate ?? todayIso());
  const [number, setNumber] = useState(initial?.number ?? '');
  const [memo, setMemo] = useState(initial?.memo ?? '');
  const [error, setError] = useState<ApiError | string | null>(null);
  const [pending, setPending] = useState(false);
  const assembly = assemblies.find((a) => a.id === assemblyId);
  const qty = tryParseMoney(quantity) ?? 0n;

  async function save() {
    setError(null);
    setPending(true);
    try {
      await onSave({ assemblyId, quantity, txnDate, number, memo, version: initial?.version });
    } catch (err) {
      setError(err instanceof ApiError ? err : String(err));
    } finally {
      setPending(false);
    }
  }
  const message =
    error instanceof ApiError
      ? [error.message, ...error.errors.map((e) => e.message)]
          .filter((m) => m && m !== 'Validation failed')
          .join(' ')
      : error;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="max-w-3xl space-y-5"
    >
      {message && <Alert>{message}</Alert>}
      <fieldset disabled={readOnly} className="grid gap-4 md:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">Assembly</span>
          <select
            aria-label="Assembly"
            value={assemblyId}
            onChange={(e) => setAssemblyId(e.target.value)}
            className={inputClass}
          >
            {assemblies.length === 0 && <option value="">No assemblies yet</option>}
            {assemblies.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          {assembly && (
            <span className="mt-1 block text-xs text-gray-500">
              On hand: {assembly.quantityOnHand}
            </span>
          )}
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">Quantity to build</span>
          <input
            aria-label="Quantity to build"
            inputMode="decimal"
            required
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className={`${inputClass} text-right tabular-nums`}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">Build date</span>
          <input
            type="date"
            aria-label="Build date"
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
      </fieldset>
      {assembly && (
        <table className="w-full text-sm" data-testid="build-components">
          <thead>
            <tr className="border-b border-gray-300 text-left text-xs uppercase tracking-wide text-gray-500">
              <th className="px-2 py-1">Component</th>
              <th className="px-2 py-1 text-right">Per assembly</th>
              <th className="px-2 py-1 text-right">Needed</th>
              <th className="px-2 py-1 text-right">On hand</th>
              {initial && <th className="px-2 py-1 text-right">Cost</th>}
            </tr>
          </thead>
          <tbody>
            {assembly.components.map((c) => {
              const needed = (parseMoney(c.quantity) * qty) / 10_000n;
              const onHand = lookups.items.find((i) => i.id === c.componentId)?.quantityOnHand;
              const short = onHand != null && parseMoney(onHand) < needed;
              const built = initial?.components.find((x) => x.itemId === c.componentId);
              return (
                <tr key={c.componentId} className="border-b border-gray-100">
                  <td className="px-2 py-1">{c.name}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{c.quantity}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{qtyText(needed)}</td>
                  <td
                    className={`px-2 py-1 text-right tabular-nums ${short && !initial ? 'font-semibold text-red-700' : ''}`}
                  >
                    {onHand ?? ''}
                  </td>
                  {initial && (
                    <td className="px-2 py-1 text-right tabular-nums">
                      {built ? formatMoney(built.cost) : ''}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {initial && (
        <p className="text-sm text-gray-700">
          Cost of the assemblies built: <strong>{formatMoney(initial.cost)}</strong>
        </p>
      )}
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-gray-700">Memo</span>
        <textarea
          aria-label="Memo"
          value={memo}
          disabled={readOnly}
          onChange={(e) => setMemo(e.target.value)}
          rows={2}
          className={inputClass}
        />
      </label>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 pt-4">
        <div>{footer}</div>
        {!readOnly && (
          <Button type="submit" loading={pending} disabled={!assembly}>
            Build and close
          </Button>
        )}
      </div>
    </form>
  );
}

function qtyText(v: bigint): string {
  const whole = v / 10_000n;
  const frac = (v % 10_000n).toString().padStart(4, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''}`;
}
