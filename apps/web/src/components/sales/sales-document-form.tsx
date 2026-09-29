'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  dueDateFromTerms,
  formatMoney,
  parseMoney,
  todayIso,
  type SalesDocType,
  type SalesDocumentDto,
  type SalesDocumentInput,
} from '@acct/shared';
import { AccountSelect, OptionSelect } from '@/components/ledger/pickers';
import { Alert, Button, cx } from '@/components/ui';
import { ApiError } from '@/lib/api';
import {
  emptyLine,
  linesFrom,
  linesToInput,
  linesTotal,
  SalesLines,
  type LineState,
} from './sales-lines';
import { billToOf, type SalesLookups } from './use-sales-lookups';

export const DOC_LABELS: Record<SalesDocType, { title: string; date: string; number: string }> = {
  invoice: { title: 'Invoice', date: 'Invoice date', number: 'Invoice no.' },
  sales_receipt: {
    title: 'Sales Receipt',
    date: 'Sales receipt date',
    number: 'Sales receipt no.',
  },
  credit_memo: { title: 'Credit Memo', date: 'Credit memo date', number: 'Credit no.' },
  refund_receipt: {
    title: 'Refund Receipt',
    date: 'Refund receipt date',
    number: 'Refund receipt no.',
  },
};

export type SaveAction = 'close' | 'new' | 'send';

const inputClass = 'block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm';

/** Turns an API validation error into a summary line; line errors are shown on the grid. */
export function formErrorText(error: ApiError | string | null): string | null {
  if (!error) return null;
  if (typeof error === 'string') return error;
  if (error.errors.length && error.errors.every((x) => x.path.startsWith('lines.')))
    return 'Some lines need attention (highlighted below).';
  const text = [
    error.message,
    ...error.errors.filter((x) => !x.path.startsWith('lines.')).map((x) => x.message),
  ]
    .filter((m) => m && m !== 'Validation failed')
    .join(' ');
  return text || 'Please check the form.';
}

function Labeled({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx('block text-sm', className)}>
      <span className="mb-1 block font-medium text-gray-700">{label}</span>
      {children}
    </label>
  );
}

/**
 * QuickBooks-style sales form: customer and addresses on top, product/service lines, message and
 * memo, totals. Ctrl/⌘+S saves.
 */
export function SalesDocumentForm({
  type,
  initial,
  lookups,
  suggestedNumber,
  defaultCustomerId,
  readOnly,
  onSave,
  footer,
}: {
  type: SalesDocType;
  initial?: SalesDocumentDto;
  lookups: SalesLookups;
  suggestedNumber?: string;
  defaultCustomerId?: string;
  readOnly?: boolean;
  onSave: (input: SalesDocumentInput, action: SaveAction) => Promise<void>;
  footer?: ReactNode;
}) {
  const labels = DOC_LABELS[type];
  const isReceipt = type === 'sales_receipt' || type === 'refund_receipt';
  const undeposited = lookups.accounts.find((a) => a.systemRole === 'undeposited_funds');
  const firstBank = lookups.accounts.find((a) => a.accountType === 'bank' && a.isActive);
  const defaultCustomer = lookups.customers.find((c) => c.id === defaultCustomerId);

  const [customerId, setCustomerId] = useState(initial?.customerId ?? defaultCustomer?.id ?? '');
  const [emailTo, setEmailTo] = useState(initial?.emailTo ?? defaultCustomer?.email ?? '');
  const [billTo, setBillTo] = useState(initial?.billTo ?? billToOf(defaultCustomer));
  const [termsId, setTermsId] = useState(initial?.termsId ?? defaultCustomer?.termsId ?? '');
  const [txnDate, setTxnDate] = useState(initial?.txnDate ?? todayIso());
  const [dueDate, setDueDate] = useState(initial?.dueDate ?? '');
  const [number, setNumber] = useState(initial?.number ?? suggestedNumber ?? '');
  const [paymentMethodId, setPaymentMethodId] = useState(initial?.paymentMethodId ?? '');
  const [reference, setReference] = useState(initial?.reference ?? '');
  const [depositAccountId, setDepositAccountId] = useState(
    initial?.depositAccountId ??
      (type === 'sales_receipt'
        ? (undeposited?.id ?? '')
        : type === 'refund_receipt'
          ? (firstBank?.id ?? '')
          : ''),
  );
  const [message, setMessage] = useState(initial?.customerMessage ?? '');
  const [memo, setMemo] = useState(initial?.memo ?? '');
  const [lines, setLines] = useState<LineState[]>(() => {
    const base = initial ? linesFrom(initial.lines) : [];
    while (base.length < 2) base.push(emptyLine());
    if (!readOnly) base.push(emptyLine());
    return base;
  });
  const [error, setError] = useState<ApiError | string | null>(null);
  const [pending, setPending] = useState<SaveAction | null>(null);
  const dueTouched = useRef(!!initial?.dueDate);

  useEffect(() => {
    if (!initial && suggestedNumber && !number) setNumber(suggestedNumber);
  }, [suggestedNumber, initial, number]);

  // Due date follows the terms and invoice date until the user sets it.
  useEffect(() => {
    if (type !== 'invoice' || dueTouched.current) return;
    const t = lookups.terms.find((x) => x.id === termsId);
    setDueDate(t ? dueDateFromTerms(txnDate, t.dueDays) : txnDate);
  }, [type, termsId, txnDate, lookups.terms]);

  function onCustomer(id: string) {
    setCustomerId(id);
    const c = lookups.customers.find((x) => x.id === id);
    if (!c) return;
    setEmailTo(c.email ?? '');
    setBillTo(billToOf(c));
    if (type === 'invoice' && c.termsId) setTermsId(c.termsId);
  }

  const fieldError = (path: string) =>
    error instanceof ApiError ? error.fieldError(path) : undefined;
  const total = linesTotal(lines);

  async function save(action: SaveAction) {
    setError(null);
    setPending(action);
    try {
      await onSave(
        {
          customerId: customerId || null,
          txnDate,
          number,
          dueDate: type === 'invoice' ? dueDate || null : null,
          termsId: type === 'invoice' ? termsId || null : null,
          billTo,
          emailTo,
          customerMessage: message,
          memo,
          paymentMethodId: isReceipt ? paymentMethodId || null : null,
          reference: isReceipt ? reference : null,
          depositAccountId: isReceipt ? depositAccountId || null : null,
          lines: linesToInput(lines),
          version: initial?.version,
        },
        action,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err : String(err));
    } finally {
      setPending(null);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'Enter')) {
      e.preventDefault();
      if (!readOnly) void save('close');
    }
  }

  const customerOptions = lookups.customers
    .filter((c) => c.isActive || c.id === customerId)
    .map((c) => ({ id: c.id, label: c.displayName, depth: c.depth }));
  const errorText = formErrorText(error);
  const paid = initial ? parseMoney(initial.total) - parseMoney(initial.balance) : 0n;

  return (
    <form
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault();
        void save('close');
      }}
      className="space-y-5 print:hidden"
    >
      {errorText && <Alert>{errorText}</Alert>}
      <fieldset disabled={readOnly} className="space-y-5">
        <div className="grid gap-4 md:grid-cols-4">
          <Labeled label="Customer" className="md:col-span-2">
            <OptionSelect
              aria-label="Customer"
              value={customerId}
              onChange={(e) => onCustomer(e.target.value)}
              placeholder="Choose a customer"
              options={customerOptions}
              className={cx(fieldError('customerId') && '!border-red-400')}
            />
            {fieldError('customerId') && (
              <span className="text-xs text-red-600">{fieldError('customerId')}</span>
            )}
          </Labeled>
          <Labeled label="Customer email" className="md:col-span-2">
            <input
              value={emailTo}
              onChange={(e) => setEmailTo(e.target.value)}
              className={inputClass}
            />
          </Labeled>
          <Labeled label="Bill to" className="md:col-span-2 md:row-span-2">
            <textarea
              aria-label="Bill to"
              value={billTo}
              onChange={(e) => setBillTo(e.target.value)}
              rows={4}
              className={inputClass}
            />
          </Labeled>
          {type === 'invoice' && (
            <Labeled label="Terms">
              <OptionSelect
                aria-label="Terms"
                value={termsId}
                onChange={(e) => {
                  dueTouched.current = false;
                  setTermsId(e.target.value);
                }}
                options={lookups.terms
                  .filter((t) => t.isActive || t.id === termsId)
                  .map((t) => ({ id: t.id, label: t.name }))}
              />
            </Labeled>
          )}
          <Labeled label={labels.date}>
            <input
              type="date"
              required
              aria-label={labels.date}
              value={txnDate}
              onChange={(e) => setTxnDate(e.target.value)}
              className={inputClass}
            />
          </Labeled>
          {type === 'invoice' && (
            <Labeled label="Due date">
              <input
                type="date"
                aria-label="Due date"
                value={dueDate}
                onChange={(e) => {
                  dueTouched.current = true;
                  setDueDate(e.target.value);
                }}
                className={cx(inputClass, fieldError('dueDate') && '!border-red-400')}
                title={fieldError('dueDate')}
              />
            </Labeled>
          )}
          <Labeled label={labels.number}>
            <input
              aria-label={labels.number}
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              maxLength={30}
              className={inputClass}
            />
          </Labeled>
          {isReceipt && (
            <>
              <Labeled label="Payment method">
                <OptionSelect
                  aria-label="Payment method"
                  value={paymentMethodId}
                  onChange={(e) => setPaymentMethodId(e.target.value)}
                  options={lookups.paymentMethods.map((m) => ({ id: m.id, label: m.name }))}
                />
              </Labeled>
              <Labeled label="Reference no.">
                <input
                  aria-label="Reference no."
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  maxLength={50}
                  className={inputClass}
                />
              </Labeled>
              <Labeled label={type === 'sales_receipt' ? 'Deposit to' : 'Refund from'}>
                <AccountSelect
                  aria-label={type === 'sales_receipt' ? 'Deposit to' : 'Refund from'}
                  accounts={lookups.accounts}
                  useNumbers={lookups.useNumbers}
                  types={
                    type === 'sales_receipt'
                      ? ['bank', 'other_current_asset']
                      : ['bank', 'credit_card', 'other_current_asset']
                  }
                  value={depositAccountId}
                  onChange={(e) => setDepositAccountId(e.target.value)}
                  className={cx(fieldError('depositAccountId') && '!border-red-400')}
                  title={fieldError('depositAccountId')}
                />
              </Labeled>
            </>
          )}
        </div>

        <SalesLines
          lines={lines}
          onChange={setLines}
          lookups={lookups}
          readOnly={readOnly}
          fieldError={fieldError}
        />

        <div className="grid gap-6 md:grid-cols-3">
          <Labeled label={`Message displayed on ${labels.title.toLowerCase()}`}>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              className={inputClass}
            />
          </Labeled>
          <Labeled label="Memo (internal)">
            <textarea
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              rows={3}
              className={inputClass}
            />
          </Labeled>
          <dl className="space-y-1 text-sm" data-testid="document-totals">
            <div className="flex justify-between text-base font-semibold">
              <dt>Total</dt>
              <dd className="tabular-nums">${formatMoney(total)}</dd>
            </div>
            {initial && type === 'invoice' && (
              <>
                <div className="flex justify-between text-gray-600">
                  <dt>Payments/credits received</dt>
                  <dd className="tabular-nums">{formatMoney(paid)}</dd>
                </div>
                <div className="flex justify-between font-semibold">
                  <dt>Balance due</dt>
                  <dd className="tabular-nums" data-testid="balance-due">
                    ${formatMoney(initial.balance)}
                  </dd>
                </div>
              </>
            )}
            {initial && type === 'credit_memo' && (
              <div className="flex justify-between text-gray-600">
                <dt>Credit remaining</dt>
                <dd className="tabular-nums">{formatMoney(initial.balance)}</dd>
              </div>
            )}
          </dl>
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 pt-4">
        <div>{footer}</div>
        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              loading={pending === 'new'}
              onClick={() => save('new')}
            >
              Save and new
            </Button>
            {type === 'invoice' && (
              <Button
                type="button"
                variant="secondary"
                loading={pending === 'send'}
                onClick={() => save('send')}
              >
                Save and send
              </Button>
            )}
            <Button type="submit" loading={pending === 'close'}>
              Save and close
            </Button>
          </div>
        )}
      </div>
    </form>
  );
}
