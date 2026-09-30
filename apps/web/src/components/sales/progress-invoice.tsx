'use client';

import { useState } from 'react';
import { formatDate, formatMoney, todayIso, type EstimateDto } from '@acct/shared';
import { Alert, Button, Dialog } from '@/components/ui';
import { ApiError, errorMessage } from '@/lib/api';

const inputClass = 'block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm';

/** What has been invoiced of an estimate so far, and its progress invoices. */
export function EstimateProgress({
  estimate,
  invoiceHref,
}: {
  estimate: EstimateDto;
  invoiceHref: (id: string) => string;
}) {
  if (estimate.progressInvoices.length === 0) return null;
  return (
    <section
      className="mt-6 rounded-md border border-gray-200 p-4 text-sm print:hidden"
      data-testid="estimate-progress"
    >
      <h3 className="mb-2 font-medium">Progress invoicing</h3>
      <p className="mb-2">
        Invoiced {formatMoney(estimate.invoicedTotal)} · Remaining{' '}
        {formatMoney(estimate.remainingTotal)} (before tax)
      </p>
      <ul className="space-y-1">
        {estimate.progressInvoices.map((i, n) => (
          <li key={i.id}>
            <a href={invoiceHref(i.id)} className="text-brand-700 hover:underline">
              Progress invoice {n + 1}
              {i.number ? ` (#${i.number})` : ''}
            </a>{' '}
            · {formatDate(i.txnDate)} · {formatMoney(i.amount)}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Creates an invoice for part of an estimate (ADR 0019): a percentage of each line, what
 * remains, or an amount per line.
 */
export function ProgressInvoiceDialog({
  open,
  estimate,
  onClose,
  onCreate,
}: {
  open: boolean;
  estimate: EstimateDto;
  onClose: () => void;
  onCreate: (input: {
    txnDate: string;
    mode: 'percent' | 'remaining' | 'amounts';
    percent?: string;
    lines?: Array<{ lineNo: number; amount: string }>;
  }) => Promise<void>;
}) {
  const [mode, setMode] = useState<'percent' | 'remaining' | 'amounts'>('percent');
  const [percent, setPercent] = useState('');
  const [txnDate, setTxnDate] = useState(todayIso());
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const lines = estimate.lines.filter((l) => l.amount !== '0.00');

  async function create() {
    setError(null);
    setPending(true);
    try {
      await onCreate({
        txnDate,
        mode,
        ...(mode === 'percent' ? { percent } : {}),
        ...(mode === 'amounts'
          ? {
              lines: Object.entries(amounts)
                .filter(([, v]) => v.trim())
                .map(([lineNo, amount]) => ({ lineNo: Number(lineNo), amount })),
            }
          : {}),
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
    <Dialog open={open} onClose={onClose} title="Create a progress invoice" wide>
      <div className="space-y-4 text-sm">
        {error && <Alert>{error}</Alert>}
        <label className="block max-w-xs">
          <span className="mb-1 block font-medium text-gray-700">Invoice date</span>
          <input
            type="date"
            aria-label="Invoice date"
            value={txnDate}
            onChange={(e) => setTxnDate(e.target.value)}
            className={inputClass}
          />
        </label>
        <fieldset className="space-y-2">
          <legend className="mb-1 font-medium text-gray-700">How much to invoice</legend>
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === 'percent'} onChange={() => setMode('percent')} />
            A percentage of each line
            <input
              aria-label="Percent to invoice"
              inputMode="decimal"
              value={percent}
              onChange={(e) => {
                setPercent(e.target.value);
                setMode('percent');
              }}
              className="w-20 rounded-md border border-gray-300 px-2 py-1 text-right"
            />
            %
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={mode === 'remaining'}
              onChange={() => setMode('remaining')}
            />
            Everything that remains ({formatMoney(estimate.remainingTotal)})
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === 'amounts'} onChange={() => setMode('amounts')} />
            An amount for each line
          </label>
        </fieldset>
        <table className="w-full" data-testid="progress-lines">
          <thead>
            <tr className="border-b border-gray-300 text-left text-xs uppercase tracking-wide text-gray-500">
              <th className="px-2 py-1">Line</th>
              <th className="px-2 py-1 text-right">Estimate</th>
              <th className="px-2 py-1 text-right">Invoiced</th>
              <th className="px-2 py-1 text-right">Remaining</th>
              {mode === 'amounts' && <th className="px-2 py-1 text-right">This invoice</th>}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.lineNo} className="border-b border-gray-100">
                <td className="px-2 py-1">{l.itemName ?? l.description}</td>
                <td className="px-2 py-1 text-right tabular-nums">{formatMoney(l.amount)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{formatMoney(l.invoiced)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{formatMoney(l.remaining)}</td>
                {mode === 'amounts' && (
                  <td className="px-2 py-1">
                    <input
                      aria-label={`Amount for line ${l.lineNo}`}
                      inputMode="decimal"
                      value={amounts[l.lineNo] ?? ''}
                      onChange={(e) => setAmounts((a) => ({ ...a, [l.lineNo]: e.target.value }))}
                      className={`${inputClass} text-right`}
                    />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={create} loading={pending}>
            Create invoice
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
