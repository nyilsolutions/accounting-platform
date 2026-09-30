'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  addDays,
  currencyInfo,
  formatDate,
  formatMoney,
  todayIso,
  type StatementDto,
} from '@acct/shared';
import { Alert, Button, Card, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { txnHref } from '@/lib/links';
import { keys } from '@/lib/queries';

const AGING: Array<[keyof StatementDto['aging'], string]> = [
  ['current', 'Current'],
  ['days1to30', '1-30 days past due'],
  ['days31to60', '31-60 days past due'],
  ['days61to90', '61-90 days past due'],
  ['over90', '90+ days past due'],
  ['total', 'Amount due'],
];

/** Balance-forward statement, laid out for printing or "Save as PDF". */
function Statement() {
  const { companyId, customerId } = useParams<{ companyId: string; customerId: string }>();
  const params = useSearchParams();
  const to = params.get('to') ?? todayIso();
  const from = params.get('from') ?? addDays(to, -30);
  const st = useQuery({
    queryKey: [...keys.sales(companyId), 'statement', customerId, from, to],
    queryFn: () =>
      api<StatementDto>(
        `/companies/${companyId}/customers/${customerId}/statement?${new URLSearchParams({ from, to })}`,
      ),
  });
  if (st.isError) return <Alert>{errorMessage(st.error)}</Alert>;
  if (st.isPending) return <Spinner />;
  const s = st.data;

  return (
    <>
      <div className="mb-4 flex items-center justify-between print:hidden">
        <Link
          href={`/c/${companyId}/sales/customers/${customerId}`}
          className="text-sm text-brand-700 hover:underline"
        >
          ← {s.customerName}
        </Link>
        <Button variant="secondary" onClick={() => window.print()}>
          Print or save PDF
        </Button>
      </div>
      <Card className="mx-auto max-w-3xl p-8 text-sm print:border-0 print:p-0 print:shadow-none">
        <div className="flex justify-between">
          <div>
            <div className="text-lg font-semibold">{s.companyName}</div>
            <div className="whitespace-pre-line text-gray-600">{s.companyAddress}</div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold uppercase tracking-wide text-gray-700">
              Statement
            </div>
            <div className="mt-1 text-gray-600">
              {formatDate(s.from)} – {formatDate(s.to)}
            </div>
            {s.currency && (
              <div className="mt-1 text-gray-600" data-testid="statement-currency">
                Amounts in {currencyInfo(s.currency).name} ({s.currency})
              </div>
            )}
          </div>
        </div>
        <div className="mt-6">
          <div className="text-xs font-semibold uppercase text-gray-500">To</div>
          <div className="whitespace-pre-line">{s.billTo ?? s.customerName}</div>
        </div>
        <table className="mt-6 w-full" data-testid="statement-table">
          <thead>
            <tr className="border-b-2 border-gray-800 text-left text-xs uppercase">
              <th className="py-1">Date</th>
              <th className="py-1">Description</th>
              <th className="py-1 text-right">Amount</th>
              <th className="py-1 text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-200">
              <td className="py-1">{formatDate(s.from)}</td>
              <td className="py-1">Balance forward</td>
              <td />
              <td className="py-1 text-right tabular-nums">{formatMoney(s.openingBalance)}</td>
            </tr>
            {s.rows.map((r, i) => (
              <tr key={i} className="border-b border-gray-200">
                <td className="py-1">{formatDate(r.txnDate)}</td>
                <td className="py-1">
                  {r.txnId ? (
                    <Link
                      href={txnHref(companyId, r.txnType, r.txnId)}
                      className="hover:underline print:no-underline"
                    >
                      {r.description}
                    </Link>
                  ) : (
                    r.description
                  )}
                </td>
                <td className="py-1 text-right tabular-nums">{formatMoney(r.amount)}</td>
                <td className="py-1 text-right tabular-nums">{formatMoney(r.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table
          className="mt-6 w-full border border-gray-300 text-center"
          data-testid="statement-aging"
        >
          <thead className="bg-gray-50 text-xs">
            <tr>
              {AGING.map(([k, l]) => (
                <th key={k} className="border border-gray-300 px-2 py-1 font-medium">
                  {l}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {AGING.map(([k]) => (
                <td
                  key={k}
                  className={`border border-gray-300 px-2 py-1 tabular-nums ${k === 'total' ? 'font-bold' : ''}`}
                >
                  {formatMoney(s.aging[k])}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </Card>
    </>
  );
}

export default function StatementPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Statement />
    </Suspense>
  );
}
