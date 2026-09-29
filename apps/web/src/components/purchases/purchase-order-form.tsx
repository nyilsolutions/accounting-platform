'use client';

import { useEffect, useState, type ReactNode } from 'react';
import {
  formatMoney,
  todayIso,
  type PurchaseOrderDto,
  type PurchaseOrderInput,
} from '@acct/shared';
import { OptionSelect } from '@/components/ledger/pickers';
import { formErrorText } from '@/components/sales/sales-document-form';
import {
  emptyLine,
  linesFrom,
  linesTotal,
  purchaseLinesToInput,
  SalesLines,
  type LineState,
} from '@/components/sales/sales-lines';
import { billToOf, type SalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Button, cx } from '@/components/ui';
import { ApiError } from '@/lib/api';

const inputClass = 'block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm';

function shipToOf(lookups: SalesLookups): string {
  const c = lookups.company;
  const cityLine = [c.city, [c.state, c.postalCode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  return [c.dbaName ?? c.legalName, c.addressLine1, c.addressLine2, cityLine]
    .filter(Boolean)
    .join('\n');
}

/** Purchase order: what you ordered from a vendor. No effect on the books until copied to a bill. */
export function PurchaseOrderForm({
  initial,
  lookups,
  suggestedNumber,
  defaultVendorId,
  readOnly,
  onSave,
  footer,
}: {
  initial?: PurchaseOrderDto;
  lookups: SalesLookups;
  suggestedNumber?: string;
  defaultVendorId?: string;
  readOnly?: boolean;
  onSave: (input: PurchaseOrderInput, andNew: boolean) => Promise<void>;
  footer?: ReactNode;
}) {
  const defaultVendor = lookups.vendors.find((v) => v.id === defaultVendorId);
  const [vendorId, setVendorId] = useState(initial?.vendorId ?? defaultVendor?.id ?? '');
  const [emailTo, setEmailTo] = useState(initial?.emailTo ?? defaultVendor?.email ?? '');
  const [vendorAddress, setVendorAddress] = useState(
    initial?.vendorAddress ?? billToOf(defaultVendor),
  );
  const [shipTo, setShipTo] = useState(initial?.shipTo ?? shipToOf(lookups));
  const [txnDate, setTxnDate] = useState(initial?.txnDate ?? todayIso());
  const [expectedDate, setExpectedDate] = useState(initial?.expectedDate ?? '');
  const [number, setNumber] = useState(initial?.number ?? suggestedNumber ?? '');
  const [message, setMessage] = useState(initial?.vendorMessage ?? '');
  const [memo, setMemo] = useState(initial?.memo ?? '');
  const [lines, setLines] = useState<LineState[]>(() => {
    const base = initial ? linesFrom(initial.lines) : [];
    while (base.length < 2) base.push(emptyLine());
    if (!readOnly) base.push(emptyLine());
    return base;
  });
  const [error, setError] = useState<ApiError | string | null>(null);
  const [pending, setPending] = useState<'close' | 'new' | null>(null);

  useEffect(() => {
    if (!initial && suggestedNumber && !number) setNumber(suggestedNumber);
  }, [suggestedNumber, initial, number]);

  function onVendor(id: string) {
    setVendorId(id);
    const v = lookups.vendors.find((x) => x.id === id);
    if (v) {
      setEmailTo(v.email ?? '');
      setVendorAddress(billToOf(v));
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
          vendorId,
          txnDate,
          expectedDate: expectedDate || null,
          number,
          vendorAddress,
          shipTo,
          emailTo,
          vendorMessage: message,
          memo,
          lines: purchaseLinesToInput(lines),
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
      className="space-y-5"
    >
      {formErrorText(error) && <Alert>{formErrorText(error)}</Alert>}
      <fieldset disabled={readOnly} className="space-y-5">
        <div className="grid gap-4 md:grid-cols-4">
          <label className="block text-sm md:col-span-2">
            <span className="mb-1 block font-medium text-gray-700">Vendor</span>
            <OptionSelect
              aria-label="Vendor"
              value={vendorId}
              onChange={(e) => onVendor(e.target.value)}
              placeholder="Choose a vendor"
              options={lookups.vendors
                .filter((v) => v.isActive || v.id === vendorId)
                .map((v) => ({ id: v.id, label: v.displayName }))}
              className={cx(fieldError('vendorId') && '!border-red-400')}
            />
          </label>
          <label className="block text-sm md:col-span-2">
            <span className="mb-1 block font-medium text-gray-700">Email</span>
            <input
              value={emailTo}
              onChange={(e) => setEmailTo(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Vendor address</span>
            <textarea
              value={vendorAddress}
              onChange={(e) => setVendorAddress(e.target.value)}
              rows={4}
              className={inputClass}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Ship to</span>
            <textarea
              value={shipTo}
              onChange={(e) => setShipTo(e.target.value)}
              rows={4}
              className={inputClass}
            />
          </label>
          <div className="grid content-start gap-4 md:col-span-2 md:grid-cols-3">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Purchase order date</span>
              <input
                type="date"
                aria-label="Purchase order date"
                required
                value={txnDate}
                onChange={(e) => setTxnDate(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Expected date</span>
              <input
                type="date"
                aria-label="Expected date"
                value={expectedDate}
                onChange={(e) => setExpectedDate(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">P.O. no.</span>
              <input
                aria-label="P.O. no."
                value={number}
                onChange={(e) => setNumber(e.target.value)}
                maxLength={30}
                className={inputClass}
              />
            </label>
          </div>
        </div>
        <SalesLines
          variant="purchase"
          lines={lines}
          onChange={setLines}
          lookups={lookups}
          readOnly={readOnly}
          fieldError={fieldError}
        />
        <div className="grid gap-6 md:grid-cols-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Your message to vendor</span>
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
          <div className="flex justify-between text-base font-semibold">
            <span>Total</span>
            <span className="tabular-nums">${formatMoney(linesTotal(lines))}</span>
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
