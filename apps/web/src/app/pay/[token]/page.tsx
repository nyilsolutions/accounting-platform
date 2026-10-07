'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  formatDate,
  formatMoney,
  type OnlinePaymentMethod,
  type PublicInvoiceDto,
} from '@acct/shared';
import { Alert, Button, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { APP_NAME } from '@/lib/config';

/** Customers see dollars with the sign. */
const usd = (v: string) => `$${formatMoney(v)}`;
/**
 * The customer's pay page (ADR 0022). No sign-in: the link in the invoice email is the
 * credential for this one invoice. Paying opens the processor's checkout for the balance.
 */
export default function PayInvoicePage() {
  const { token } = useParams<{ token: string }>();
  const [paidReturn, setPaidReturn] = useState(false);
  const [pending, setPending] = useState<OnlinePaymentMethod | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPaidReturn(new URLSearchParams(window.location.search).has('paid'));
  }, []);
  const q = useQuery({
    queryKey: ['public-pay', token],
    queryFn: () => api<PublicInvoiceDto>(`/public/pay/${token}`),
    retry: false,
    // After checkout the payment can take a moment to be recorded.
    refetchInterval: (query) =>
      paidReturn && query.state.data?.status === 'payable' ? 2000 : false,
  });

  async function pay(method: OnlinePaymentMethod) {
    setError(null);
    setPending(method);
    try {
      const r = await api<{ url: string }>(`/public/pay/${token}/checkout`, {
        method: 'POST',
        body: { method },
      });
      window.location.assign(r.url);
    } catch (err) {
      setError(errorMessage(err));
      setPending(null);
    }
  }

  if (q.isPending)
    return (
      <Shell>
        <Spinner />
      </Shell>
    );
  if (q.isError)
    return (
      <Shell>
        <h1 className="text-xl font-semibold text-gray-900">Payment link not found</h1>
        <p className="mt-2 text-sm text-gray-700">
          This link is not valid any more. Ask the business that sent it for a new one.
        </p>
      </Shell>
    );
  const inv = q.data;
  return (
    <Shell>
      <p className="text-sm font-medium text-brand-700">{inv.companyName}</p>
      <h1 className="mt-1 text-2xl font-semibold text-gray-900">
        Invoice {inv.number ? `#${inv.number}` : ''}
      </h1>
      <p className="mt-1 text-sm text-gray-600">
        {inv.customerName && <>For {inv.customerName} · </>}
        {formatDate(inv.txnDate)}
        {inv.dueDate && <> · Due {formatDate(inv.dueDate)}</>}
      </p>

      <table className="mt-5 w-full text-sm" data-testid="pay-invoice-lines">
        <tbody className="divide-y divide-gray-100">
          {inv.lines.map((l, i) => (
            <tr key={i}>
              <td className="py-1.5 pr-4 text-gray-700">{l.description}</td>
              <td className="py-1.5 text-right tabular-nums">{usd(l.amount)}</td>
            </tr>
          ))}
          {inv.taxLines.map((t, i) => (
            <tr key={`t${i}`}>
              <td className="py-1.5 pr-4 text-gray-600">{t.name}</td>
              <td className="py-1.5 text-right tabular-nums">{usd(t.amount)}</td>
            </tr>
          ))}
          <tr className="font-medium">
            <td className="py-1.5 pr-4">Total</td>
            <td className="py-1.5 text-right tabular-nums">{usd(inv.total)}</td>
          </tr>
        </tbody>
      </table>

      <div className="mt-5 rounded-md bg-gray-50 p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-gray-600">Balance due</span>
          <span className="text-2xl font-semibold tabular-nums" data-testid="pay-balance">
            {usd(inv.balance)}
          </span>
        </div>
      </div>

      <div className="mt-5 space-y-3">
        {error && <Alert>{error}</Alert>}
        {inv.status === 'paid' && (
          <Alert kind="success">
            {paidReturn ? 'Thank you. Your payment was received.' : 'This invoice is paid.'}
          </Alert>
        )}
        {inv.status === 'processing' && <Alert kind="info">{inv.reason}</Alert>}
        {inv.status === 'unavailable' && <Alert kind="info">{inv.reason}</Alert>}
        {inv.status === 'payable' && paidReturn && (
          <Alert kind="info">Your payment is being confirmed…</Alert>
        )}
        {inv.status === 'payable' &&
          !paidReturn &&
          inv.methods.map((m) => (
            <Button
              key={m}
              type="button"
              className="w-full justify-center"
              variant={m === inv.methods[0] ? 'primary' : 'secondary'}
              disabled={pending !== null}
              onClick={() => pay(m)}
            >
              {pending === m
                ? 'Opening checkout…'
                : `Pay ${usd(inv.balance)} by ${m === 'card' ? 'card' : 'bank transfer (ACH)'}`}
            </Button>
          ))}
      </div>

      {(inv.companyEmail || inv.companyPhone) && (
        <p className="mt-6 text-xs text-gray-500">
          Questions? Contact {inv.companyName}
          {inv.companyEmail && (
            <>
              {' '}
              at{' '}
              <a href={`mailto:${inv.companyEmail}`} className="underline">
                {inv.companyEmail}
              </a>
            </>
          )}
          {inv.companyPhone && <> · {inv.companyPhone}</>}
        </p>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-full items-start justify-center bg-gray-50 px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">{children}</div>
        <p className="mt-4 text-center text-xs">
          <Link href="/portal/customer" className="text-brand-700 hover:underline">
            See all your invoices
          </Link>
        </p>
        <p className="mt-2 text-center text-xs text-gray-400">
          Payments are processed securely by Stripe · {APP_NAME}
        </p>
      </div>
    </main>
  );
}
