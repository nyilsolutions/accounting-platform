'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  formatDate,
  formatMoney,
  type CustomerInvoiceDetailDto,
  type PayLinkDto,
} from '@acct/shared';
import { CustomerShell } from '@/components/portal/customer-shell';
import { Alert, Button, Card, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

/** One invoice: printable, with Pay online when the business takes online payments. */
export default function CustomerInvoicePage() {
  const { id } = useParams<{ id: string }>();
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['customer-portal', 'invoice', id],
    queryFn: () => api<CustomerInvoiceDetailDto>(`/portal/customer/invoices/${id}`),
  });
  async function pay() {
    setError(null);
    try {
      const r = await api<PayLinkDto>(`/portal/customer/invoices/${id}/pay`, { method: 'POST' });
      window.location.assign(new URL(r.url).pathname);
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <CustomerShell>
      {(me) =>
        q.isPending ? (
          <Spinner />
        ) : q.isError ? (
          <Alert>{errorMessage(q.error)}</Alert>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 print:hidden">
              <Link
                href="/portal/customer/account"
                className="text-sm text-brand-700 hover:underline"
              >
                ← Invoices
              </Link>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={() => window.print()}>
                  Print or save PDF
                </Button>
                {q.data.canPayOnline && (
                  <Button size="sm" onClick={pay}>
                    Pay ${formatMoney(q.data.balance)} online
                  </Button>
                )}
              </div>
            </div>
            {error && (
              <div className="mb-4">
                <Alert>{error}</Alert>
              </div>
            )}
            <Card className="p-6" data-testid="customer-invoice">
              <div className="mb-4 flex flex-wrap justify-between gap-4">
                <div>
                  <p className="text-lg font-semibold text-gray-900">{me.companyName}</p>
                  <p className="text-sm text-gray-600">Invoice {q.data.number ?? ''}</p>
                </div>
                <div className="text-right text-sm text-gray-700">
                  <p>Date {formatDate(q.data.txnDate)}</p>
                  {q.data.dueDate && <p>Due {formatDate(q.data.dueDate)}</p>}
                </div>
              </div>
              <p className="mb-3 text-sm text-gray-700">Bill to {me.customerName}</p>
              <table className="w-full text-sm">
                <thead className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="py-2">Description</th>
                    <th className="py-2 text-right">Qty</th>
                    <th className="py-2 text-right">Rate</th>
                    <th className="py-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {q.data.lines.map((l, i) => (
                    <tr key={i}>
                      <td className="py-1.5">{l.description}</td>
                      <td className="py-1.5 text-right">{l.quantity ?? ''}</td>
                      <td className="py-1.5 text-right">{l.rate ? formatMoney(l.rate) : ''}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatMoney(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <dl className="ml-auto mt-4 max-w-xs space-y-1 text-sm">
                {q.data.taxLines.length > 0 && (
                  <div className="flex justify-between">
                    <dt>Subtotal</dt>
                    <dd className="tabular-nums">{formatMoney(q.data.subtotal)}</dd>
                  </div>
                )}
                {q.data.taxLines.map((t) => (
                  <div key={t.name} className="flex justify-between">
                    <dt>{t.name}</dt>
                    <dd className="tabular-nums">{formatMoney(t.amount)}</dd>
                  </div>
                ))}
                <div className="flex justify-between font-medium">
                  <dt>Total</dt>
                  <dd className="tabular-nums">{formatMoney(q.data.total)}</dd>
                </div>
                <div className="flex justify-between text-base font-semibold">
                  <dt>Balance due</dt>
                  <dd className="tabular-nums" data-testid="customer-invoice-balance">
                    {q.data.currency ? `${q.data.currency} ` : '$'}
                    {formatMoney(q.data.balance)}
                  </dd>
                </div>
              </dl>
              {q.data.customerMessage && (
                <p className="mt-4 text-sm text-gray-700">{q.data.customerMessage}</p>
              )}
            </Card>
          </>
        )
      }
    </CustomerShell>
  );
}
