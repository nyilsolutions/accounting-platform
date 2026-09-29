'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  formatDate,
  formatMoney,
  moneyToString,
  parseMoney,
  todayIso,
  tryParseMoney,
  type Money,
  type OpenItemDto,
  type PaymentDto,
  type PaymentInput,
} from '@acct/shared';
import { AccountSelect, OptionSelect } from '@/components/ledger/pickers';
import { Alert, Button, cx } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formErrorText } from './sales-document-form';
import type { SalesLookups } from './use-sales-lookups';

const inputClass = 'block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm';
const amt = (v: string | undefined) => (v ? (tryParseMoney(v) ?? 0n) : 0n);
const min = (a: Money, b: Money) => (a < b ? a : b);

/**
 * Receive payment. Enter the amount and it is applied to the oldest open invoices first, or tick
 * invoices and credits individually. Anything received beyond what is applied stays as a credit
 * for the customer.
 */
export function PaymentForm({
  companyId,
  initial,
  lookups,
  defaultCustomerId,
  defaultInvoiceId,
  readOnly,
  onSave,
  footer,
}: {
  companyId: string;
  initial?: PaymentDto;
  lookups: SalesLookups;
  defaultCustomerId?: string;
  defaultInvoiceId?: string;
  readOnly?: boolean;
  onSave: (input: PaymentInput, andNew: boolean) => Promise<void>;
  footer?: ReactNode;
}) {
  const undeposited = lookups.accounts.find((a) => a.systemRole === 'undeposited_funds');
  const [customerId, setCustomerId] = useState(initial?.customerId ?? defaultCustomerId ?? '');
  const [txnDate, setTxnDate] = useState(initial?.txnDate ?? todayIso());
  const [amount, setAmount] = useState(initial?.amount ?? '');
  const [paymentMethodId, setPaymentMethodId] = useState(initial?.paymentMethodId ?? '');
  const [reference, setReference] = useState(initial?.reference ?? '');
  const [depositAccountId, setDepositAccountId] = useState(
    initial?.depositAccountId ?? undeposited?.id ?? '',
  );
  const [memo, setMemo] = useState(initial?.memo ?? '');
  const [applied, setApplied] = useState<Record<string, string>>(() =>
    Object.fromEntries((initial?.applications ?? []).map((a) => [a.txnId, a.amount])),
  );
  const [error, setError] = useState<ApiError | string | null>(null);
  const [pending, setPending] = useState<'close' | 'new' | null>(null);
  const prefilled = useRef(false);

  const open = useQuery({
    queryKey: ['company', companyId, 'sales', 'open-items', customerId, initial?.id ?? null],
    queryFn: () =>
      api<OpenItemDto[]>(
        `/companies/${companyId}/customers/${customerId}/open-items${initial ? `?paymentId=${initial.id}` : ''}`,
      ),
    enabled: !!customerId,
  });
  const items = open.data ?? [];
  const invoices = items.filter((i) => i.txnType === 'invoice');
  const credits = items.filter((i) => i.txnType === 'credit_memo');

  // Coming from an invoice's "Receive payment": pay that invoice in full.
  useEffect(() => {
    if (prefilled.current || !defaultInvoiceId || !open.data) return;
    prefilled.current = true;
    const inv = open.data.find((i) => i.id === defaultInvoiceId);
    if (inv) {
      setApplied({ [inv.id]: inv.open });
      setAmount(inv.open);
    }
  }, [open.data, defaultInvoiceId]);

  const invoicesPaid = invoices.reduce((s, i) => s + amt(applied[i.id]), 0n);
  const creditsUsed = credits.reduce((s, i) => s + amt(applied[i.id]), 0n);
  const received = amt(amount);
  const toCredit = received + creditsUsed - invoicesPaid;

  function onCustomer(id: string) {
    setCustomerId(id);
    setApplied({});
  }

  /** Applies the amount received (plus any credits ticked) to the oldest invoices first. */
  function autoApply(value: string) {
    let left = amt(value) + creditsUsed;
    const next: Record<string, string> = Object.fromEntries(
      credits.filter((c) => applied[c.id]).map((c) => [c.id, applied[c.id]!]),
    );
    for (const inv of invoices) {
      const take = min(left, parseMoney(inv.open));
      if (take > 0n) next[inv.id] = moneyToString(take);
      left -= take;
    }
    setApplied(next);
  }

  function toggle(item: OpenItemDto, checked: boolean) {
    const next = { ...applied };
    if (!checked) delete next[item.id];
    else if (item.txnType === 'invoice') next[item.id] = item.open;
    else
      next[item.id] = moneyToString(
        min(
          parseMoney(item.open),
          invoicesPaid - creditsUsed > 0n ? invoicesPaid - creditsUsed : parseMoney(item.open),
        ),
      );
    setApplied(next);
    // With nothing typed in "Amount received", it follows what is ticked.
    if (!amount || received === 0n) {
      const inv = invoices.reduce((s, i) => s + amt(next[i.id]), 0n);
      const cr = credits.reduce((s, i) => s + amt(next[i.id]), 0n);
      if (inv - cr > 0n) setAmount(moneyToString(inv - cr));
    }
  }

  const fieldError = (path: string) =>
    error instanceof ApiError ? error.fieldError(path) : undefined;

  async function save(andNew: boolean) {
    setError(null);
    setPending(andNew ? 'new' : 'close');
    try {
      await onSave(
        {
          customerId,
          txnDate,
          amount: amount || '0',
          paymentMethodId: paymentMethodId || null,
          reference,
          depositAccountId: depositAccountId || null,
          memo,
          applications: Object.entries(applied)
            .filter(([, v]) => amt(v) > 0n)
            .map(([targetId, v]) => ({ targetId, amount: moneyToString(amt(v)) })),
          version: initial?.version,
        },
        andNew,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err : String(err));
    } finally {
      setPending(null);
    }
  }

  const rowError = (id: string) => {
    const idx = Object.keys(applied)
      .filter((k) => amt(applied[k]) > 0n)
      .indexOf(id);
    return idx >= 0
      ? (fieldError(`applications.${idx}.amount`) ?? fieldError(`applications.${idx}.targetId`))
      : undefined;
  };

  const table = (title: string, rows: OpenItemDto[], testId: string) => (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-gray-900">{title}</h3>
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full min-w-[640px] text-sm" data-testid={testId}>
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="w-10 px-3 py-2" />
              <th className="px-3 py-2">Description</th>
              <th className="px-3 py-2">Due date</th>
              <th className="px-3 py-2 text-right">Original amount</th>
              <th className="px-3 py-2 text-right">Open balance</th>
              <th className="w-36 px-3 py-2 text-right">Payment</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-1.5">
                  <input
                    type="checkbox"
                    aria-label={`Apply ${r.number ?? r.id}`}
                    checked={amt(applied[r.id]) > 0n}
                    onChange={(e) => toggle(r, e.target.checked)}
                  />
                </td>
                <td className="px-3 py-1.5">
                  {r.txnType === 'invoice' ? 'Invoice' : 'Credit Memo'} {r.number ?? ''} (
                  {formatDate(r.txnDate)})
                </td>
                <td className="px-3 py-1.5">{r.dueDate ? formatDate(r.dueDate) : ''}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{formatMoney(r.total)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{formatMoney(r.open)}</td>
                <td className="px-3 py-1">
                  <input
                    aria-label={`Payment for ${r.number ?? r.id}`}
                    inputMode="decimal"
                    value={applied[r.id] ?? ''}
                    onChange={(e) => setApplied({ ...applied, [r.id]: e.target.value })}
                    className={cx(
                      inputClass,
                      'text-right tabular-nums',
                      rowError(r.id) && '!border-red-400',
                    )}
                    title={rowError(r.id)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const errorText = formErrorText(
    error instanceof ApiError && error.errors.every((e) => e.path.startsWith('applications.'))
      ? error.errors.length
        ? error.errors.map((e) => e.message).join(' ')
        : error
      : error,
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
          e.preventDefault();
          if (!readOnly) void save(false);
        }
      }}
      className="space-y-5"
    >
      {errorText && <Alert>{errorText}</Alert>}
      <fieldset disabled={readOnly} className="space-y-5">
        <div className="grid gap-4 md:grid-cols-4">
          <label className="block text-sm md:col-span-2">
            <span className="mb-1 block font-medium text-gray-700">Customer</span>
            <OptionSelect
              aria-label="Customer"
              value={customerId}
              onChange={(e) => onCustomer(e.target.value)}
              placeholder="Choose a customer"
              disabled={!!initial}
              options={lookups.customers
                .filter((c) => c.isActive || c.id === customerId)
                .map((c) => ({ id: c.id, label: c.displayName, depth: c.depth }))}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Payment date</span>
            <input
              type="date"
              aria-label="Payment date"
              required
              value={txnDate}
              onChange={(e) => setTxnDate(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Amount received</span>
            <input
              aria-label="Amount received"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onBlur={() => {
                if (!amount || tryParseMoney(amount) === null) return;
                setAmount(moneyToString(amt(amount)));
                autoApply(amount);
              }}
              className={cx(
                inputClass,
                'text-right tabular-nums',
                fieldError('amount') && '!border-red-400',
              )}
              title={fieldError('amount')}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Payment method</span>
            <OptionSelect
              aria-label="Payment method"
              value={paymentMethodId}
              onChange={(e) => setPaymentMethodId(e.target.value)}
              options={lookups.paymentMethods.map((m) => ({ id: m.id, label: m.name }))}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Reference no.</span>
            <input
              aria-label="Reference no."
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              maxLength={50}
              className={inputClass}
            />
          </label>
          <label className="block text-sm md:col-span-2">
            <span className="mb-1 block font-medium text-gray-700">Deposit to</span>
            <AccountSelect
              aria-label="Deposit to"
              accounts={lookups.accounts}
              useNumbers={lookups.useNumbers}
              types={['bank', 'other_current_asset']}
              value={depositAccountId}
              onChange={(e) => setDepositAccountId(e.target.value)}
              className={cx(fieldError('depositAccountId') && '!border-red-400')}
              title={fieldError('depositAccountId')}
            />
          </label>
        </div>

        {customerId && open.isSuccess && (
          <>
            {invoices.length > 0 ? (
              table('Outstanding transactions', invoices, 'open-invoices')
            ) : (
              <p className="text-sm text-gray-500">This customer has no open invoices.</p>
            )}
            {credits.length > 0 && table('Credits', credits, 'open-credits')}
          </>
        )}

        <div className="grid gap-6 md:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Memo</span>
            <textarea
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              rows={3}
              className={inputClass}
            />
          </label>
          <dl className="space-y-1 text-sm" data-testid="payment-summary">
            <div className="flex justify-between">
              <dt>Amount to apply</dt>
              <dd className="tabular-nums">{formatMoney(invoicesPaid)}</dd>
            </div>
            {creditsUsed > 0n && (
              <div className="flex justify-between text-gray-600">
                <dt>Credits applied</dt>
                <dd className="tabular-nums">{formatMoney(creditsUsed)}</dd>
              </div>
            )}
            <div
              className={cx('flex justify-between font-semibold', toCredit < 0n && 'text-red-700')}
            >
              <dt>{toCredit < 0n ? 'Applied more than received' : 'Amount to credit'}</dt>
              <dd className="tabular-nums" data-testid="amount-to-credit">
                {formatMoney(toCredit < 0n ? -toCredit : toCredit)}
              </dd>
            </div>
            {initial && (
              <div className="flex justify-between text-gray-600">
                <dt>Unapplied (saved)</dt>
                <dd className="tabular-nums">{formatMoney(initial.unapplied)}</dd>
              </div>
            )}
          </dl>
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 pt-4">
        <div>{footer}</div>
        {!readOnly && (
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              loading={pending === 'new'}
              onClick={() => save(true)}
            >
              Save and new
            </Button>
            <Button type="submit" loading={pending === 'close'}>
              Save and close
            </Button>
          </div>
        )}
      </div>
    </form>
  );
}
