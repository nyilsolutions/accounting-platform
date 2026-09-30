'use client';

import {
  formatDate,
  formatMoney,
  moneyToString,
  parseMoney,
  tryParseMoney,
  type Money,
  type OpenBillDto,
} from '@acct/shared';
import { cx } from '@/components/ui';

const amt = (v: string | undefined) => (v ? (tryParseMoney(v) ?? 0n) : 0n);

/** Amount paid per vendor: bills − credits applied. */
export function paymentTotals(items: OpenBillDto[], applied: Record<string, string>) {
  const byVendor = new Map<string, Money>();
  let total = 0n;
  for (const i of items) {
    const v = amt(applied[i.id]);
    if (!v) continue;
    const signed = i.txnType === 'bill' ? v : -v;
    byVendor.set(i.vendorId, (byVendor.get(i.vendorId) ?? 0n) + signed);
    total += signed;
  }
  return { total, byVendor };
}

/**
 * Open bills and vendor credits with a checkbox and a payment amount each. Ticking a bill pays it
 * in full; ticking a credit applies as much of it as that vendor's ticked bills allow.
 */
export function BillApplications({
  items,
  applied,
  onChange,
  showVendor,
  fieldError,
  readOnly,
}: {
  items: OpenBillDto[];
  applied: Record<string, string>;
  onChange: (applied: Record<string, string>) => void;
  showVendor: boolean;
  fieldError?: (id: string) => string | undefined;
  readOnly?: boolean;
}) {
  function toggle(item: OpenBillDto, checked: boolean) {
    const next = { ...applied };
    if (!checked) delete next[item.id];
    else if (item.txnType === 'bill') next[item.id] = item.open;
    else {
      const vendorBills = items
        .filter((i) => i.vendorId === item.vendorId && i.txnType === 'bill')
        .reduce((s, i) => s + amt(next[i.id]), 0n);
      const vendorCredits = items
        .filter((i) => i.vendorId === item.vendorId && i.txnType === 'vendor_credit')
        .reduce((s, i) => s + amt(next[i.id]), 0n);
      const room = vendorBills - vendorCredits;
      const open = parseMoney(item.open);
      next[item.id] = moneyToString(room > 0n && room < open ? room : open);
    }
    onChange(next);
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="w-full min-w-[720px] text-sm" data-testid="open-bills">
        <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="w-10 px-3 py-2" />
            {showVendor && <th className="px-3 py-2">Payee</th>}
            <th className="px-3 py-2">Transaction</th>
            <th className="px-3 py-2">Due date</th>
            <th className="px-3 py-2 text-right">Open balance</th>
            <th className="w-36 px-3 py-2 text-right">Payment / credit</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {items.map((r) => {
            const label =
              `${r.txnType === 'bill' ? 'Bill' : 'Vendor credit'} ${r.number ?? ''}`.trim();
            const err = fieldError?.(r.id);
            return (
              <tr key={r.id} className={cx(r.txnType === 'vendor_credit' && 'bg-emerald-50/40')}>
                <td className="px-3 py-1.5">
                  <input
                    type="checkbox"
                    disabled={readOnly}
                    aria-label={`Pay ${r.vendorName} ${label}`}
                    checked={amt(applied[r.id]) > 0n}
                    onChange={(e) => toggle(r, e.target.checked)}
                  />
                </td>
                {showVendor && <td className="px-3 py-1.5">{r.vendorName}</td>}
                <td className="px-3 py-1.5">
                  {label} <span className="text-gray-500">({formatDate(r.txnDate)})</span>
                </td>
                <td className="px-3 py-1.5">{r.dueDate ? formatDate(r.dueDate) : ''}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {r.txnType === 'vendor_credit' ? '-' : ''}
                  {formatMoney(r.open)}
                  {r.currency && <span className="ml-1 text-xs text-gray-500">{r.currency}</span>}
                </td>
                <td className="px-3 py-1">
                  <input
                    aria-label={`Amount for ${r.vendorName} ${label}`}
                    inputMode="decimal"
                    disabled={readOnly}
                    value={applied[r.id] ?? ''}
                    onChange={(e) => onChange({ ...applied, [r.id]: e.target.value })}
                    className={cx(
                      'block w-full rounded-md border border-gray-300 px-2 py-1 text-right text-sm tabular-nums',
                      err && '!border-red-400',
                    )}
                    title={err}
                  />
                </td>
              </tr>
            );
          })}
          {items.length === 0 && (
            <tr>
              <td colSpan={showVendor ? 6 : 5} className="px-3 py-8 text-center text-gray-500">
                No unpaid bills.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Applications to send: ticked items with a positive amount, in table order. */
export function toApplications(items: OpenBillDto[], applied: Record<string, string>) {
  return items
    .filter((i) => amt(applied[i.id]) > 0n)
    .map((i) => ({ targetId: i.id, amount: moneyToString(amt(applied[i.id])) }));
}
