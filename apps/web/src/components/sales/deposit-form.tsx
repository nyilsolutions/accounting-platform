'use client';

import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  formatDate,
  formatMoney,
  moneyToString,
  parseMoney,
  sumMoney,
  todayIso,
  TXN_TYPE_LABELS,
  tryParseMoney,
  type DepositDto,
  type DepositInput,
  type PendingDepositDto,
} from '@acct/shared';
import { AccountSelect, cellInputClass, OptionSelect } from '@/components/ledger/pickers';
import { Alert, Button, cx } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formErrorText } from './sales-document-form';
import type { SalesLookups } from './use-sales-lookups';

interface OtherLine {
  key: number;
  customerId: string;
  accountId: string;
  description: string;
  amount: string;
}
let nextKey = 1;
const emptyOther = (): OtherLine => ({
  key: nextKey++,
  customerId: '',
  accountId: '',
  description: '',
  amount: '',
});
const inputClass = 'block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm';

/**
 * Bank deposit: choose the payments and sales receipts waiting in Undeposited Funds that went to
 * the bank together, plus any other funds deposited, so the total matches the bank statement.
 */
export function DepositForm({
  companyId,
  initial,
  lookups,
  readOnly,
  onSave,
  footer,
}: {
  companyId: string;
  initial?: DepositDto;
  lookups: SalesLookups;
  readOnly?: boolean;
  onSave: (input: DepositInput) => Promise<void>;
  footer?: ReactNode;
}) {
  const firstBank = lookups.accounts.find((a) => a.accountType === 'bank' && a.isActive);
  const [txnDate, setTxnDate] = useState(initial?.txnDate ?? todayIso());
  const [depositAccountId, setDepositAccountId] = useState(
    initial?.depositAccountId ?? firstBank?.id ?? '',
  );
  const [memo, setMemo] = useState(initial?.memo ?? '');
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set((initial?.lines ?? []).filter((l) => l.sourceTxnId).map((l) => l.sourceTxnId!)),
  );
  const [others, setOthers] = useState<OtherLine[]>(() => {
    const base = (initial?.lines ?? [])
      .filter((l) => !l.sourceTxnId)
      .map((l) => ({
        key: nextKey++,
        customerId: l.customerId ?? '',
        accountId: l.accountId,
        description: l.description ?? '',
        amount: l.amount,
      }));
    base.push(emptyOther());
    return base;
  });
  const [error, setError] = useState<ApiError | string | null>(null);
  const [pending, setPending] = useState(false);

  const pendingItems = useQuery({
    queryKey: ['company', companyId, 'sales', 'deposits-pending', initial?.id ?? null],
    queryFn: () =>
      api<PendingDepositDto[]>(
        `/companies/${companyId}/deposits/pending${initial ? `?depositId=${initial.id}` : ''}`,
      ),
  });
  const available = pendingItems.data ?? [];
  const usedOthers = others.filter((o) => o.accountId || o.amount || o.description);
  const total =
    sumMoney(available.filter((p) => selected.has(p.txnId)).map((p) => parseMoney(p.amount))) +
    sumMoney(usedOthers.map((o) => tryParseMoney(o.amount) ?? 0n));

  function updateOther(key: number, patch: Partial<OtherLine>) {
    const next = others.map((o) => (o.key === key ? { ...o, ...patch } : o));
    const last = next[next.length - 1]!;
    if (last.accountId || last.amount || last.description) next.push(emptyOther());
    setOthers(next);
  }

  async function save() {
    setError(null);
    setPending(true);
    try {
      await onSave({
        txnDate,
        depositAccountId,
        memo,
        lines: [
          ...available.filter((p) => selected.has(p.txnId)).map((p) => ({ sourceTxnId: p.txnId })),
          ...usedOthers.map((o) => ({
            accountId: o.accountId || null,
            customerId: o.customerId || null,
            description: o.description,
            amount: o.amount,
          })),
        ],
        version: initial?.version,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err : String(err));
    } finally {
      setPending(false);
    }
  }

  const allSelected = available.length > 0 && available.every((p) => selected.has(p.txnId));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="space-y-5"
    >
      {formErrorText(error) && <Alert>{formErrorText(error)}</Alert>}
      <fieldset disabled={readOnly} className="space-y-5">
        <div className="grid gap-4 md:grid-cols-4">
          <label className="block text-sm md:col-span-2">
            <span className="mb-1 block font-medium text-gray-700">Account</span>
            <AccountSelect
              aria-label="Deposit account"
              accounts={lookups.accounts}
              useNumbers={lookups.useNumbers}
              types={['bank']}
              value={depositAccountId}
              onChange={(e) => setDepositAccountId(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Date</span>
            <input
              type="date"
              aria-label="Deposit date"
              required
              value={txnDate}
              onChange={(e) => setTxnDate(e.target.value)}
              className={inputClass}
            />
          </label>
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold text-gray-900">
            Select the payments included in this deposit
          </h3>
          {pendingItems.isSuccess && available.length === 0 ? (
            <p className="text-sm text-gray-500">No payments are waiting in Undeposited Funds.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
              <table className="w-full min-w-[640px] text-sm" data-testid="pending-deposits">
                <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="w-10 px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label="Select all payments"
                        checked={allSelected}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked ? new Set(available.map((p) => p.txnId)) : new Set(),
                          )
                        }
                      />
                    </th>
                    <th className="px-3 py-2">Received from</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Payment method</th>
                    <th className="px-3 py-2">Ref no.</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {available.map((p) => (
                    <tr key={p.txnId}>
                      <td className="px-3 py-1.5">
                        <input
                          type="checkbox"
                          aria-label={`Deposit ${p.customerName ?? ''} ${p.amount}`}
                          checked={selected.has(p.txnId)}
                          onChange={(e) => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(p.txnId);
                            else next.delete(p.txnId);
                            setSelected(next);
                          }}
                        />
                      </td>
                      <td className="px-3 py-1.5">{p.customerName}</td>
                      <td className="px-3 py-1.5">{formatDate(p.txnDate)}</td>
                      <td className="px-3 py-1.5">
                        {TXN_TYPE_LABELS[p.txnType]} {p.number ?? ''}
                      </td>
                      <td className="px-3 py-1.5">
                        {lookups.paymentMethods.find((m) => m.id === p.paymentMethodId)?.name}
                      </td>
                      <td className="px-3 py-1.5">{p.reference}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {formatMoney(p.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold text-gray-900">Add funds to this deposit</h3>
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="w-56 px-2 py-2">Received from</th>
                  <th className="w-64 px-2 py-2">Account</th>
                  <th className="px-2 py-2">Description</th>
                  <th className="w-32 px-2 py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {others.map((o, i) => (
                  <tr key={o.key}>
                    <td className="px-1 py-1">
                      <OptionSelect
                        aria-label={`Other line ${i + 1} received from`}
                        value={o.customerId}
                        onChange={(e) => updateOther(o.key, { customerId: e.target.value })}
                        options={lookups.customers
                          .filter((c) => c.isActive)
                          .map((c) => ({ id: c.id, label: c.displayName, depth: c.depth }))}
                        className="border-transparent hover:border-gray-300"
                      />
                    </td>
                    <td className="px-1 py-1">
                      <AccountSelect
                        aria-label={`Other line ${i + 1} account`}
                        accounts={lookups.accounts}
                        useNumbers={lookups.useNumbers}
                        value={o.accountId}
                        placeholder=""
                        onChange={(e) => updateOther(o.key, { accountId: e.target.value })}
                        className="border-transparent hover:border-gray-300"
                      />
                    </td>
                    <td className="px-1 py-1">
                      <input
                        aria-label={`Other line ${i + 1} description`}
                        value={o.description}
                        onChange={(e) => updateOther(o.key, { description: e.target.value })}
                        className={cellInputClass}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <input
                        aria-label={`Other line ${i + 1} amount`}
                        inputMode="decimal"
                        value={o.amount}
                        onChange={(e) => updateOther(o.key, { amount: e.target.value })}
                        onBlur={() =>
                          tryParseMoney(o.amount) !== null &&
                          o.amount &&
                          updateOther(o.key, { amount: moneyToString(tryParseMoney(o.amount)!) })
                        }
                        className={cx(cellInputClass, 'text-right tabular-nums')}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

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
          <div className="flex items-start justify-end text-base font-semibold">
            <span className="mr-6">Deposit total</span>
            <span className="tabular-nums" data-testid="deposit-total">
              ${formatMoney(total)}
            </span>
          </div>
        </div>
      </fieldset>
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
