'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  dueDateFromTerms,
  formatMoney,
  parseMoney,
  todayIso,
  type AccountType,
  type PurchaseDocType,
  type PurchaseDocumentDto,
  type PurchaseDocumentInput,
} from '@acct/shared';
import { AccountSelect, OptionSelect } from '@/components/ledger/pickers';
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
import { api, ApiError } from '@/lib/api';

export const PURCHASE_LABELS: Record<
  PurchaseDocType,
  { title: string; party: string; date: string; number: string; account?: string }
> = {
  bill: { title: 'Bill', party: 'Vendor', date: 'Bill date', number: 'Bill no.' },
  vendor_credit: {
    title: 'Vendor Credit',
    party: 'Vendor',
    date: 'Credit date',
    number: 'Ref no.',
  },
  check: {
    title: 'Check',
    party: 'Payee',
    date: 'Payment date',
    number: 'Check no.',
    account: 'Bank account',
  },
  expense: {
    title: 'Expense',
    party: 'Payee',
    date: 'Payment date',
    number: 'Ref no.',
    account: 'Payment account',
  },
  cc_credit: {
    title: 'Credit Card Credit',
    party: 'Payee',
    date: 'Credit date',
    number: 'Ref no.',
    account: 'Credit card',
  },
};

const ACCOUNT_TYPES: Partial<Record<PurchaseDocType, AccountType[]>> = {
  check: ['bank'],
  expense: ['bank', 'credit_card'],
  cc_credit: ['credit_card'],
};

const inputClass = 'block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm';

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
 * QuickBooks-style purchase form: vendor/payee, payment account for cash purchases, category or
 * product lines (with the customer/job the cost is for), memo and totals. Ctrl/⌘+S saves.
 */
export function PurchaseDocumentForm({
  companyId,
  type,
  initial,
  lookups,
  defaultVendorId,
  readOnly,
  onSave,
  footer,
}: {
  companyId: string;
  type: PurchaseDocType;
  initial?: PurchaseDocumentDto;
  lookups: SalesLookups;
  defaultVendorId?: string;
  readOnly?: boolean;
  onSave: (input: PurchaseDocumentInput, andNew: boolean) => Promise<void>;
  footer?: ReactNode;
}) {
  const labels = PURCHASE_LABELS[type];
  const cash = type === 'check' || type === 'expense' || type === 'cc_credit';
  const defaultVendor = lookups.vendors.find((v) => v.id === defaultVendorId);
  const firstAccount = lookups.accounts.find(
    (a) => a.isActive && (ACCOUNT_TYPES[type] ?? []).includes(a.accountType),
  );

  const [vendorId, setVendorId] = useState(initial?.vendorId ?? defaultVendor?.id ?? '');
  const [termsId, setTermsId] = useState(initial?.termsId ?? defaultVendor?.termsId ?? '');
  const [txnDate, setTxnDate] = useState(initial?.txnDate ?? todayIso());
  const [dueDate, setDueDate] = useState(initial?.dueDate ?? '');
  const [number, setNumber] = useState(initial?.number ?? '');
  const [paymentAccountId, setPaymentAccountId] = useState(
    initial?.paymentAccountId ?? firstAccount?.id ?? '',
  );
  const [paymentMethodId, setPaymentMethodId] = useState(initial?.paymentMethodId ?? '');
  const [printLater, setPrintLater] = useState(initial?.printStatus === 'to_print');
  const [mailingAddress, setMailingAddress] = useState(
    initial?.mailingAddress ?? billToOf(defaultVendor),
  );
  const [memo, setMemo] = useState(initial?.memo ?? '');
  const [lines, setLines] = useState<LineState[]>(() => {
    const base = initial ? linesFrom(initial.lines) : [];
    while (base.length < 2) base.push(emptyLine());
    if (!readOnly) base.push(emptyLine());
    return base;
  });
  const [error, setError] = useState<ApiError | string | null>(null);
  const [pending, setPending] = useState<'close' | 'new' | null>(null);
  const dueTouched = useRef(!!initial?.dueDate);
  const numberTouched = useRef(!!initial);

  // Suggested check number for the chosen bank account.
  const nextCheck = useQuery({
    queryKey: ['company', companyId, 'purchases', 'next-check', paymentAccountId],
    queryFn: () =>
      api<{ number: string }>(
        `/companies/${companyId}/checks/next-number?paymentAccountId=${paymentAccountId}`,
      ),
    enabled: type === 'check' && !!paymentAccountId && !initial,
  });
  useEffect(() => {
    if (type === 'check' && !numberTouched.current && nextCheck.data)
      setNumber(nextCheck.data.number);
  }, [type, nextCheck.data]);

  // Bill due date follows terms and bill date until the user sets it.
  useEffect(() => {
    if (type !== 'bill' || dueTouched.current) return;
    const t = lookups.terms.find((x) => x.id === termsId);
    setDueDate(t ? dueDateFromTerms(txnDate, t.dueDays) : txnDate);
  }, [type, termsId, txnDate, lookups.terms]);

  function onVendor(id: string) {
    setVendorId(id);
    const v = lookups.vendors.find((x) => x.id === id);
    if (!v) return;
    if (type === 'bill' && v.termsId) setTermsId(v.termsId);
    if (type === 'check') setMailingAddress(billToOf(v));
    // A vendor's default expense account fills the first empty line.
    if (v.defaultExpenseAccountId && lines.every((l) => !l.product)) {
      setLines([{ ...lines[0]!, product: `a:${v.defaultExpenseAccountId}` }, ...lines.slice(1)]);
    }
  }

  const fieldError = (path: string) =>
    error instanceof ApiError ? error.fieldError(path) : undefined;
  const total = linesTotal(lines);

  async function save(andNew: boolean) {
    setError(null);
    setPending(andNew ? 'new' : 'close');
    try {
      await onSave(
        {
          vendorId: vendorId || null,
          txnDate,
          number: type === 'check' && printLater ? null : number,
          dueDate: type === 'bill' ? dueDate || null : null,
          termsId: type === 'bill' ? termsId || null : null,
          paymentAccountId: cash ? paymentAccountId || null : null,
          paymentMethodId: type === 'expense' ? paymentMethodId || null : null,
          printLater: type === 'check' ? printLater : undefined,
          mailingAddress: type === 'check' ? mailingAddress : null,
          memo,
          lines: purchaseLinesToInput(lines),
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

  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'Enter')) {
      e.preventDefault();
      if (!readOnly) void save(false);
    }
  }

  const errorText = formErrorText(error);
  const paid = initial ? parseMoney(initial.total) - parseMoney(initial.balance) : 0n;

  return (
    <form
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
      className="space-y-5 print:hidden"
    >
      {errorText && <Alert>{errorText}</Alert>}
      <fieldset disabled={readOnly} className="space-y-5">
        <div className="grid gap-4 md:grid-cols-4">
          <Labeled label={labels.party} className="md:col-span-2">
            <OptionSelect
              aria-label={labels.party}
              value={vendorId}
              onChange={(e) => onVendor(e.target.value)}
              placeholder={
                type === 'bill' || type === 'vendor_credit' ? 'Choose a vendor' : '(none)'
              }
              options={lookups.vendors
                .filter((v) => v.isActive || v.id === vendorId)
                .map((v) => ({ id: v.id, label: v.displayName }))}
              className={cx(fieldError('vendorId') && '!border-red-400')}
            />
            {fieldError('vendorId') && (
              <span className="text-xs text-red-600">{fieldError('vendorId')}</span>
            )}
          </Labeled>
          {cash && (
            <Labeled label={labels.account!} className="md:col-span-2">
              <AccountSelect
                aria-label={labels.account}
                accounts={lookups.accounts}
                useNumbers={lookups.useNumbers}
                types={ACCOUNT_TYPES[type]}
                value={paymentAccountId}
                onChange={(e) => {
                  numberTouched.current = !!initial;
                  setPaymentAccountId(e.target.value);
                }}
                className={cx(fieldError('paymentAccountId') && '!border-red-400')}
                title={fieldError('paymentAccountId')}
              />
            </Labeled>
          )}
          {type === 'check' && (
            <Labeled label="Mailing address" className="md:col-span-2 md:row-span-2">
              <textarea
                aria-label="Mailing address"
                value={mailingAddress}
                onChange={(e) => setMailingAddress(e.target.value)}
                rows={4}
                className={inputClass}
              />
            </Labeled>
          )}
          {type === 'bill' && (
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
          {type === 'bill' && (
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
          {type === 'expense' && (
            <Labeled label="Payment method">
              <OptionSelect
                aria-label="Payment method"
                value={paymentMethodId}
                onChange={(e) => setPaymentMethodId(e.target.value)}
                options={lookups.paymentMethods.map((m) => ({ id: m.id, label: m.name }))}
              />
            </Labeled>
          )}
          <Labeled label={labels.number}>
            <input
              aria-label={labels.number}
              value={type === 'check' && printLater ? '' : number}
              disabled={type === 'check' && printLater}
              placeholder={type === 'check' && printLater ? 'To print' : ''}
              onChange={(e) => {
                numberTouched.current = true;
                setNumber(e.target.value);
              }}
              maxLength={30}
              className={inputClass}
            />
          </Labeled>
          {type === 'check' && (
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input
                type="checkbox"
                checked={printLater}
                onChange={(e) => setPrintLater(e.target.checked)}
              />{' '}
              Print later
            </label>
          )}
        </div>

        <SalesLines
          variant="purchase"
          lines={lines}
          onChange={setLines}
          lookups={lookups}
          readOnly={readOnly}
          fieldError={fieldError}
        />

        <div className="grid gap-6 md:grid-cols-2">
          <Labeled label="Memo">
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
            {initial && type === 'bill' && (
              <>
                <div className="flex justify-between text-gray-600">
                  <dt>Paid</dt>
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
            {initial && type === 'vendor_credit' && (
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
