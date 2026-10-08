'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { formatMoney, todayIso, type EstimateDto, type EstimateInput } from '@acct/shared';
import { OptionSelect } from '@/components/ledger/pickers';
import { Alert, Button, cx } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { formErrorText } from './sales-document-form';
import {
  emptyLine,
  linesFrom,
  linesToInput,
  linesTotal,
  SalesLines,
  type LineState,
} from './sales-lines';
import { SalesTaxTotals, useTaxPreview } from './sales-tax-fields';
import { billToOf, type SalesLookups } from './use-sales-lookups';

const inputClass = 'block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm';

/** Estimate (quote). No effect on the books until it is converted to an invoice. */
export function EstimateForm({
  initial,
  lookups,
  suggestedNumber,
  defaultCustomerId,
  readOnly,
  onSave,
  footer,
}: {
  initial?: EstimateDto;
  lookups: SalesLookups;
  suggestedNumber?: string;
  defaultCustomerId?: string;
  readOnly?: boolean;
  onSave: (input: EstimateInput, andNew: boolean) => Promise<void>;
  footer?: ReactNode;
}) {
  const defaultCustomer = lookups.customers.find((c) => c.id === defaultCustomerId);
  const [customerId, setCustomerId] = useState(initial?.customerId ?? defaultCustomer?.id ?? '');
  const [emailTo, setEmailTo] = useState(initial?.emailTo ?? defaultCustomer?.email ?? '');
  const [billTo, setBillTo] = useState(initial?.billTo ?? billToOf(defaultCustomer));
  const [txnDate, setTxnDate] = useState(initial?.txnDate ?? todayIso());
  const [expirationDate, setExpirationDate] = useState(initial?.expirationDate ?? '');
  const [number, setNumber] = useState(initial?.number ?? suggestedNumber ?? '');
  const [message, setMessage] = useState(initial?.customerMessage ?? '');
  const [memo, setMemo] = useState(initial?.memo ?? '');
  const [lines, setLines] = useState<LineState[]>(() => {
    const base = initial ? linesFrom(initial.lines) : [];
    while (base.length < 2) base.push(emptyLine());
    if (!readOnly) base.push(emptyLine());
    return base;
  });
  const [taxRateId, setTaxRateId] = useState(
    initial ? (initial.taxRateId ?? '') : (defaultCustomer?.taxRateId ?? ''),
  );
  const [error, setError] = useState<ApiError | string | null>(null);
  const [pending, setPending] = useState<'close' | 'new' | null>(null);
  const customer = lookups.customers.find((c) => c.id === customerId);
  const tax = useTaxPreview(lookups, {
    rateId: taxRateId,
    txnDate,
    lines,
    exempt: customer?.taxExempt ?? false,
  });
  const showTax = tax.rates.length > 0 || !!initial?.taxRateId;

  useEffect(() => {
    if (!initial && suggestedNumber && !number) setNumber(suggestedNumber);
  }, [suggestedNumber, initial, number]);

  function onCustomer(id: string) {
    setCustomerId(id);
    const c = lookups.customers.find((x) => x.id === id);
    if (c) {
      setEmailTo(c.email ?? '');
      setBillTo(billToOf(c));
      if (!initial && c.taxRateId) setTaxRateId(c.taxRateId);
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
          expirationDate: expirationDate || null,
          number,
          billTo,
          emailTo,
          customerMessage: message,
          memo,
          taxRateId: taxRateId || null,
          lines: linesToInput(lines),
        },
        andNew,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err : String(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
      className="space-y-5 print:hidden"
    >
      {formErrorText(error) && <Alert>{formErrorText(error)}</Alert>}
      <fieldset disabled={readOnly} className="space-y-5">
        <div className="grid gap-4 md:grid-cols-4">
          <label className="block text-sm md:col-span-2">
            <span className="mb-1 block font-medium text-gray-700">Customer</span>
            <OptionSelect
              aria-label="Customer"
              value={customerId}
              onChange={(e) => onCustomer(e.target.value)}
              placeholder="Choose a customer"
              options={lookups.customers
                .filter((c) => c.isActive || c.id === customerId)
                .map((c) => ({ id: c.id, label: c.displayName, depth: c.depth }))}
              className={cx(fieldError('customerId') && '!border-red-400')}
            />
          </label>
          <label className="block text-sm md:col-span-2">
            <span className="mb-1 block font-medium text-gray-700">Customer email</span>
            <input
              value={emailTo}
              onChange={(e) => setEmailTo(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block text-sm md:col-span-2 md:row-span-2">
            <span className="mb-1 block font-medium text-gray-700">Bill to</span>
            <textarea
              value={billTo}
              onChange={(e) => setBillTo(e.target.value)}
              rows={4}
              className={inputClass}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Estimate date</span>
            <input
              type="date"
              aria-label="Estimate date"
              required
              value={txnDate}
              onChange={(e) => setTxnDate(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Expiration date</span>
            <input
              type="date"
              aria-label="Expiration date"
              value={expirationDate}
              onChange={(e) => setExpirationDate(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Estimate no.</span>
            <input
              aria-label="Estimate no."
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              maxLength={30}
              className={inputClass}
            />
          </label>
        </div>
        <SalesLines
          lines={lines}
          onChange={setLines}
          lookups={lookups}
          readOnly={readOnly}
          fieldError={fieldError}
          showTax={showTax}
        />
        <div className="grid gap-6 md:grid-cols-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">
              Message displayed on estimate
            </span>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              className={inputClass}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Memo (internal)</span>
            <textarea
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              rows={3}
              className={inputClass}
            />
          </label>
          <div className="space-y-1 text-sm">
            {showTax && (
              <>
                <div className="flex justify-between text-gray-700">
                  <span>Subtotal</span>
                  <span className="tabular-nums">{formatMoney(linesTotal(lines))}</span>
                </div>
                <SalesTaxTotals
                  preview={tax}
                  rateId={taxRateId}
                  onRate={setTaxRateId}
                  exempt={customer?.taxExempt ?? false}
                  readOnly={readOnly}
                  fieldError={fieldError}
                />
              </>
            )}
            <div className="flex justify-between text-base font-semibold">
              <span>Total</span>
              <span className="tabular-nums">
                ${formatMoney(linesTotal(lines) + (tax.total > 0n ? tax.total : 0n))}
              </span>
            </div>
          </div>
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
