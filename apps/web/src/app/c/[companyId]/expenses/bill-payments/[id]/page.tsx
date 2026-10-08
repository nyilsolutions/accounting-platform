'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatCurrency,
  formatMoney,
  moneyToString,
  type BillPaymentDto,
  type OpenBillDto,
} from '@acct/shared';
import { useClosingPassword } from '@/components/ledger/closing-password';
import { ExchangeRateField } from '@/components/currency/currency-fields';
import { AccountSelect } from '@/components/ledger/pickers';
import {
  BillApplications,
  paymentTotals,
  toApplications,
} from '@/components/purchases/bill-applications';
import { formErrorText } from '@/components/sales/sales-document-form';
import { useSalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Badge, Button, Card, Spinner } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { keys, ledgerKeys, useAccess } from '@/lib/queries';
import { Attachments } from '@/components/documents/attachments';

const inputClass = 'block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm';

export default function BillPaymentPage() {
  const { companyId, id } = useParams<{ companyId: string; id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const { ready, lookups } = useSalesLookups(companyId);
  const closing = useClosingPassword();
  const payment = useQuery({
    queryKey: keys.salesDoc(companyId, 'bill-payments', id),
    queryFn: () => api<BillPaymentDto>(`/companies/${companyId}/bill-payments/${id}`),
  });
  const p = payment.data;
  const open = useQuery({
    queryKey: ['company', companyId, 'sales', 'open-bills', p?.vendorId, id],
    queryFn: () =>
      api<OpenBillDto[]>(
        `/companies/${companyId}/open-bills?vendorId=${p!.vendorId}&paymentId=${id}`,
      ),
    enabled: !!p,
  });
  const [applied, setApplied] = useState<Record<string, string>>({});
  const [txnDate, setTxnDate] = useState('');
  const [number, setNumber] = useState('');
  const [memo, setMemo] = useState('');
  const [paymentAccountId, setPaymentAccountId] = useState('');
  const [exchangeRate, setExchangeRate] = useState('');
  const [error, setError] = useState<ApiError | string | null>(null);
  useEffect(() => {
    if (!p) return;
    setApplied(Object.fromEntries(p.applications.map((a) => [a.txnId, a.amount])));
    setTxnDate(p.txnDate);
    setNumber(p.number ?? '');
    setMemo(p.memo ?? '');
    setPaymentAccountId(p.paymentAccountId);
    setExchangeRate(p.exchangeRate ?? '');
  }, [p]);

  if (payment.isError) return <Alert>{errorMessage(payment.error)}</Alert>;
  if (!ready || !p) return <Spinner />;
  const readOnly = !access.can('purchases.manage') || p.status !== 'posted';
  const items = open.data ?? [];
  const { total } = paymentTotals(items, applied);
  const refresh = () =>
    Promise.all(ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })));

  async function save() {
    setError(null);
    try {
      await closing.run(async (closingPassword) => {
        await api(`/companies/${companyId}/bill-payments/${id}`, {
          method: 'PUT',
          body: {
            vendorId: p!.vendorId,
            txnDate,
            paymentAccountId,
            number: p!.printStatus === 'to_print' ? null : number,
            printLater: p!.printStatus === 'to_print',
            memo,
            mailingAddress: p!.mailingAddress,
            applications: toApplications(items, applied),
            exchangeRate: p!.currency ? exchangeRate.trim() || null : null,
            version: p!.version,
            closingPassword,
          },
        });
        await refresh();
        router.push(`/c/${companyId}/expenses`);
      });
    } catch (err) {
      setError(err instanceof ApiError ? err : String(err));
    }
  }

  async function action(path: string, method: string, text: string) {
    if (!confirm(text)) return;
    setError(null);
    try {
      await closing.run(async (closingPassword) => {
        await api(`/companies/${companyId}/bill-payments/${id}${path}`, {
          method,
          body: { closingPassword },
        });
        await refresh();
        router.push(`/c/${companyId}/expenses`);
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-gray-600">
        <Link href={`/c/${companyId}/expenses`} className="text-brand-700 hover:underline">
          ← Expenses
        </Link>
        <span className="font-medium text-gray-900">
          Bill payment · {p.vendorName} ·{' '}
          {p.currency ? formatCurrency(p.amount, p.currency) : formatMoney(p.amount)}
          {p.homeAmount && (
            <>
              {' '}
              = {formatCurrency(p.homeAmount, null)} · exchange gain (loss){' '}
              <span data-testid="exchange-gain-loss">
                {formatCurrency(p.exchangeGainLoss ?? '0', null)}
              </span>
            </>
          )}
        </span>
        {p.printStatus === 'to_print' && <Badge tone="amber">To print</Badge>}
        {p.status === 'void' && <Badge tone="amber">Void</Badge>}
      </div>
      {formErrorText(error) && (
        <div className="mb-4">
          <Alert>{formErrorText(error)}</Alert>
        </div>
      )}
      <Card className="mb-4 p-4">
        <fieldset disabled={readOnly} className="grid gap-4 md:grid-cols-4">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Payment account</span>
            <AccountSelect
              aria-label="Payment account"
              accounts={lookups.accounts}
              useNumbers={lookups.useNumbers}
              types={['bank', 'credit_card']}
              value={paymentAccountId}
              onChange={(e) => setPaymentAccountId(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Payment date</span>
            <input
              type="date"
              value={txnDate}
              onChange={(e) => setTxnDate(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Check / ref no.</span>
            <input
              value={number}
              disabled={p.printStatus === 'to_print'}
              placeholder={p.printStatus === 'to_print' ? 'To print' : ''}
              onChange={(e) => setNumber(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Memo</span>
            <input value={memo} onChange={(e) => setMemo(e.target.value)} className={inputClass} />
          </label>
          {p.currency && (
            <div className="md:col-span-2">
              <ExchangeRateField
                companyId={companyId}
                currency={p.currency}
                date={txnDate}
                value={exchangeRate}
                onChange={setExchangeRate}
                amount={moneyToString(total)}
              />
            </div>
          )}
        </fieldset>
      </Card>
      <BillApplications
        items={items}
        applied={applied}
        onChange={setApplied}
        showVendor={false}
        readOnly={readOnly}
      />
      <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-gray-200 pt-4">
        <div className="flex gap-2">
          {!readOnly && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() =>
                action('/void', 'POST', 'Void this bill payment? Its bills become unpaid again.')
              }
            >
              Void
            </Button>
          )}
          {access.can('purchases.manage') && (
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={() =>
                action('', 'DELETE', 'Delete this bill payment? Its bills become unpaid again.')
              }
            >
              Delete
            </Button>
          )}
        </div>
        <div className="flex items-center gap-4">
          <span className="font-semibold tabular-nums">
            Amount paid {p.currency ? formatCurrency(total, p.currency) : `$${formatMoney(total)}`}
          </span>
          {!readOnly && <Button onClick={save}>Save and close</Button>}
        </div>
      </div>
      <Attachments companyId={companyId} entityType="transaction" entityId={id} />
      {closing.dialog}
    </>
  );
}
