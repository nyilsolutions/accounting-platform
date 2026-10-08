'use client';

import { useState, type ReactNode } from 'react';
import {
  ACCOUNT_TYPES,
  isTransferAccountType,
  moneyToString,
  todayIso,
  tryParseMoney,
  type TransferDto,
  type TransferInput,
} from '@acct/shared';
import { AccountSelect } from '@/components/ledger/pickers';
import { formErrorText } from '@/components/sales/sales-document-form';
import type { SalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Button } from '@/components/ui';
import { ApiError } from '@/lib/api';

const inputClass = 'block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm';
const TRANSFER_TYPES = ACCOUNT_TYPES.filter(isTransferAccountType);

/** Transfer between balance sheet accounts. Paying a credit card is a transfer to the card. */
export function TransferForm({
  initial,
  defaults,
  lookups,
  readOnly,
  onSave,
  footer,
}: {
  initial?: TransferDto;
  defaults?: { fromAccountId?: string; toAccountId?: string };
  lookups: SalesLookups;
  readOnly?: boolean;
  onSave: (input: TransferInput) => Promise<void>;
  footer?: ReactNode;
}) {
  const firstBank = lookups.accounts.find((a) => a.accountType === 'bank' && a.isActive);
  const [fromAccountId, setFrom] = useState(
    initial?.fromAccountId ?? defaults?.fromAccountId ?? firstBank?.id ?? '',
  );
  const [toAccountId, setTo] = useState(initial?.toAccountId ?? defaults?.toAccountId ?? '');
  const [txnDate, setTxnDate] = useState(initial?.txnDate ?? todayIso());
  const [amount, setAmount] = useState(initial?.amount ?? '');
  const [memo, setMemo] = useState(initial?.memo ?? '');
  const [error, setError] = useState<ApiError | string | null>(null);
  const [pending, setPending] = useState(false);
  const fieldError = (path: string) =>
    error instanceof ApiError ? error.fieldError(path) : undefined;
  const to = lookups.accounts.find((a) => a.id === toAccountId);

  async function save() {
    setError(null);
    setPending(true);
    try {
      await onSave({
        fromAccountId,
        toAccountId,
        txnDate,
        amount,
        memo,
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
      className="max-w-2xl space-y-5"
    >
      {formErrorText(error) && <Alert>{formErrorText(error)}</Alert>}
      <fieldset disabled={readOnly} className="grid gap-4 md:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">Transfer funds from</span>
          <AccountSelect
            aria-label="Transfer from"
            accounts={lookups.accounts}
            useNumbers={lookups.useNumbers}
            types={TRANSFER_TYPES}
            value={fromAccountId}
            onChange={(e) => setFrom(e.target.value)}
          />
          {fieldError('fromAccountId') && (
            <span className="text-xs text-red-600">{fieldError('fromAccountId')}</span>
          )}
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">Transfer funds to</span>
          <AccountSelect
            aria-label="Transfer to"
            accounts={lookups.accounts}
            useNumbers={lookups.useNumbers}
            types={TRANSFER_TYPES}
            value={toAccountId}
            onChange={(e) => setTo(e.target.value)}
          />
          {fieldError('toAccountId') && (
            <span className="text-xs text-red-600">{fieldError('toAccountId')}</span>
          )}
          {to?.accountType === 'credit_card' && (
            <span className="mt-1 block text-xs text-gray-500">
              This pays down the credit card.
            </span>
          )}
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">Date</span>
          <input
            type="date"
            aria-label="Transfer date"
            required
            value={txnDate}
            onChange={(e) => setTxnDate(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">Amount</span>
          <input
            aria-label="Transfer amount"
            inputMode="decimal"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onBlur={() => {
              const v = tryParseMoney(amount);
              if (v !== null) setAmount(moneyToString(v));
            }}
            className={`${inputClass} text-right tabular-nums`}
          />
          {fieldError('amount') && (
            <span className="text-xs text-red-600">{fieldError('amount')}</span>
          )}
        </label>
        <label className="block text-sm md:col-span-2">
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
