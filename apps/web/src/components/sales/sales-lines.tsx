'use client';

import {
  ACCOUNT_TYPE_INFO,
  formatMoney,
  lineAmount,
  moneyToString,
  sumMoney,
  tryParseMoney,
  type Money,
  type SalesLineInput,
} from '@acct/shared';
import { cx } from '@/components/ui';
import { cellInputClass, OptionSelect } from '@/components/ledger/pickers';
import type { SalesLookups } from './use-sales-lookups';

export interface LineState {
  key: number;
  /** "i:<itemId>" for a product/service, "a:<accountId>" for an income account. */
  product: string;
  description: string;
  quantity: string;
  rate: string;
  amount: string;
  classId: string;
  serviceDate: string;
}

let nextKey = 1;
export const emptyLine = (): LineState => ({
  key: nextKey++,
  product: '',
  description: '',
  quantity: '',
  rate: '',
  amount: '',
  classId: '',
  serviceDate: '',
});

const QTY = /^-?\d{1,15}(\.\d{1,4})?$/;
const validQty = (v: string) => QTY.test(v.trim());

export const isBlankLine = (l: LineState) =>
  !l.product && !l.description && !l.quantity && !l.rate && !l.amount;

/** The amount the API will compute for the line (quantity × rate, or the amount entered). */
export function lineTotal(l: LineState): Money {
  if (l.quantity && l.rate && validQty(l.quantity) && validQty(l.rate))
    return lineAmount(l.quantity.trim(), l.rate.trim());
  return tryParseMoney(l.amount) ?? 0n;
}

export function linesTotal(lines: LineState[]): Money {
  return sumMoney(lines.map(lineTotal));
}

export function linesFrom(
  lines: Array<{
    itemId: string | null;
    accountId?: string | null;
    description: string | null;
    quantity: string | null;
    rate: string | null;
    amount: string;
    classId: string | null;
    serviceDate: string | null;
  }>,
): LineState[] {
  return lines.map((l) => ({
    key: nextKey++,
    product: l.itemId ? `i:${l.itemId}` : l.accountId ? `a:${l.accountId}` : '',
    description: l.description ?? '',
    quantity: l.quantity ?? '',
    rate: l.rate ?? '',
    amount: l.amount,
    classId: l.classId ?? '',
    serviceDate: l.serviceDate ?? '',
  }));
}

export function linesToInput(lines: LineState[]): SalesLineInput[] {
  return lines
    .filter((l) => !isBlankLine(l))
    .map((l) => ({
      itemId: l.product.startsWith('i:') ? l.product.slice(2) : null,
      accountId: l.product.startsWith('a:') ? l.product.slice(2) : null,
      description: l.description,
      quantity: l.quantity.trim() || null,
      rate: l.rate.trim() || null,
      amount: moneyToString(lineTotal(l)),
      classId: l.classId || null,
      serviceDate: l.serviceDate || null,
    }));
}

const LINE_ACCOUNT_TYPES = ['income', 'other_income'] as const;

/**
 * Product/service grid for invoices, receipts, credit memos and estimates. Choosing a product
 * fills its description and price; quantity × rate gives the amount, or type the amount directly.
 */
export function SalesLines({
  lines,
  onChange,
  lookups,
  readOnly,
  fieldError,
}: {
  lines: LineState[];
  onChange: (lines: LineState[]) => void;
  lookups: SalesLookups;
  readOnly?: boolean;
  fieldError: (path: string) => string | undefined;
}) {
  const hasClasses = lookups.classes.length > 0;
  const selected = new Set(lines.map((l) => l.product));
  const productOptions = [
    ...lookups.items
      .filter((i) => (i.isActive && i.incomeAccountId) || selected.has(`i:${i.id}`))
      .map((i) => ({ id: `i:${i.id}`, label: i.name })),
    ...lookups.accounts
      .filter(
        (a) =>
          ((LINE_ACCOUNT_TYPES as readonly string[]).includes(a.accountType) && a.isActive) ||
          selected.has(`a:${a.id}`),
      )
      .map((a) => ({
        id: `a:${a.id}`,
        label: `${a.fullName} (${ACCOUNT_TYPE_INFO[a.accountType].label} account)`,
      })),
  ];

  function update(key: number, patch: Partial<LineState>) {
    const next = lines.map((l) => (l.key === key ? { ...l, ...patch } : l));
    if (!isBlankLine(next[next.length - 1]!)) next.push(emptyLine());
    onChange(next);
  }

  function onProduct(l: LineState, product: string) {
    const patch: Partial<LineState> = { product };
    if (product.startsWith('i:')) {
      const item = lookups.items.find((i) => i.id === product.slice(2));
      if (item) {
        patch.description = item.description ?? l.description;
        if (item.salesPrice) {
          patch.rate = item.salesPrice;
          patch.quantity = l.quantity || '1';
        }
      }
    }
    update(l.key, patch);
  }

  const err = (i: number, field: string) => fieldError(`lines.${i}.${field}`);

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="w-full min-w-[860px] text-sm">
        <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="w-8 px-2 py-2">#</th>
            <th className="w-32 px-2 py-2">Service date</th>
            <th className="w-60 px-2 py-2">Product/service</th>
            <th className="px-2 py-2">Description</th>
            <th className="w-20 px-2 py-2 text-right">Qty</th>
            <th className="w-28 px-2 py-2 text-right">Rate</th>
            <th className="w-32 px-2 py-2 text-right">Amount</th>
            {hasClasses && <th className="w-36 px-2 py-2">Class</th>}
            <th className="w-8" />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {lines.map((l, i) => {
            const computed = !!(l.quantity && l.rate);
            return (
              <tr key={l.key} data-testid={`sales-line-${i}`}>
                <td className="px-2 text-center text-xs text-gray-400">{i + 1}</td>
                <td className="px-1 py-1">
                  <input
                    type="date"
                    aria-label={`Line ${i + 1} service date`}
                    value={l.serviceDate}
                    onChange={(e) => update(l.key, { serviceDate: e.target.value })}
                    className={cellInputClass}
                  />
                </td>
                <td className="px-1 py-1">
                  <OptionSelect
                    aria-label={`Line ${i + 1} product or service`}
                    options={productOptions}
                    value={l.product}
                    onChange={(e) => onProduct(l, e.target.value)}
                    className={cx(
                      'border-transparent hover:border-gray-300',
                      (err(i, 'itemId') || err(i, 'accountId')) && '!border-red-400',
                    )}
                    title={err(i, 'itemId') ?? err(i, 'accountId')}
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    aria-label={`Line ${i + 1} description`}
                    value={l.description}
                    onChange={(e) => update(l.key, { description: e.target.value })}
                    className={cellInputClass}
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    aria-label={`Line ${i + 1} quantity`}
                    inputMode="decimal"
                    value={l.quantity}
                    onChange={(e) => update(l.key, { quantity: e.target.value })}
                    className={cx(
                      cellInputClass,
                      'text-right tabular-nums',
                      l.quantity && !validQty(l.quantity) && '!border-red-400',
                    )}
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    aria-label={`Line ${i + 1} rate`}
                    inputMode="decimal"
                    value={l.rate}
                    onChange={(e) => update(l.key, { rate: e.target.value })}
                    className={cx(
                      cellInputClass,
                      'text-right tabular-nums',
                      l.rate && !validQty(l.rate) && '!border-red-400',
                    )}
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    aria-label={`Line ${i + 1} amount`}
                    inputMode="decimal"
                    value={computed ? moneyToString(lineTotal(l)) : l.amount}
                    // Typing an amount over a quantity × rate keeps the quantity and drops the rate.
                    onChange={(e) => update(l.key, { amount: e.target.value, rate: '' })}
                    onBlur={() =>
                      !computed &&
                      l.amount &&
                      tryParseMoney(l.amount) !== null &&
                      update(l.key, { amount: moneyToString(tryParseMoney(l.amount)!) })
                    }
                    className={cx(
                      cellInputClass,
                      'text-right tabular-nums',
                      err(i, 'amount') && '!border-red-400',
                    )}
                    title={err(i, 'amount')}
                  />
                </td>
                {hasClasses && (
                  <td className="px-1 py-1">
                    <OptionSelect
                      aria-label={`Line ${i + 1} class`}
                      options={lookups.classes.map((c) => ({
                        id: c.id,
                        label: c.name,
                        depth: c.depth,
                      }))}
                      value={l.classId}
                      onChange={(e) => update(l.key, { classId: e.target.value })}
                      className="border-transparent hover:border-gray-300"
                    />
                  </td>
                )}
                <td className="px-1 text-center">
                  {!readOnly && lines.length > 1 && (
                    <button
                      type="button"
                      aria-label={`Remove line ${i + 1}`}
                      className="text-gray-400 hover:text-red-600"
                      onClick={() => {
                        const next = lines.filter((x) => x.key !== l.key);
                        onChange(next.length ? next : [emptyLine()]);
                      }}
                    >
                      ×
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot className="border-t-2 border-gray-200 bg-gray-50 font-medium">
          <tr>
            <td colSpan={6} className="px-3 py-2 text-right text-xs uppercase text-gray-500">
              Total
            </td>
            <td className="px-3 py-2 text-right tabular-nums" data-testid="lines-total">
              {formatMoney(linesTotal(lines))}
            </td>
            <td colSpan={hasClasses ? 2 : 1} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
