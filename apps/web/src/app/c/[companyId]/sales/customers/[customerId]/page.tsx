'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  addDays,
  formatMoney,
  todayIso,
  type CustomerBalanceDto,
  type CustomerDto,
} from '@acct/shared';
import { SalesTransactionsTable } from '@/components/sales/transactions-table';
import { billToOf } from '@/components/sales/use-sales-lookups';
import { Alert, Button, buttonClass, Card, Dialog, Spinner, TextInput } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, useAccess } from '@/lib/queries';

export default function CustomerPage() {
  const { companyId, customerId } = useParams<{ companyId: string; customerId: string }>();
  const router = useRouter();
  const access = useAccess(companyId);
  const [statement, setStatement] = useState(false);
  const customer = useQuery({
    queryKey: ['company', companyId, 'customers', 'one', customerId],
    queryFn: () => api<CustomerDto>(`/companies/${companyId}/customers/${customerId}`),
  });
  const balance = useQuery({
    queryKey: [...keys.sales(companyId), 'balances', customerId],
    queryFn: async () =>
      (
        await api<CustomerBalanceDto[]>(
          `/companies/${companyId}/customer-balances?customerId=${customerId}`,
        )
      )[0],
  });
  if (customer.isError) return <Alert>{errorMessage(customer.error)}</Alert>;
  if (customer.isPending) return <Spinner />;
  const c = customer.data;
  const base = `/c/${companyId}/sales`;
  const canManage = access.can('sales.manage');

  function openStatement(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    router.push(
      `${base}/customers/${customerId}/statement?${new URLSearchParams({ from: String(f.get('from')), to: String(f.get('to')) })}`,
    );
  }

  return (
    <>
      <div className="mb-4 text-sm">
        <Link href={`${base}/customers`} className="text-brand-700 hover:underline">
          ← Customers
        </Link>
      </div>
      <div className="mb-5 grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-gray-900" data-testid="customer-name">
                {c.displayName}
              </h2>
              <div className="mt-2 whitespace-pre-line text-sm text-gray-600">{billToOf(c)}</div>
              <div className="mt-1 text-sm text-gray-600">
                {[c.email, c.phone].filter(Boolean).join(' · ')}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {canManage && (
                <>
                  <Link
                    href={`${base}/invoices/new?customerId=${customerId}`}
                    className={buttonClass('primary', 'sm')}
                  >
                    New invoice
                  </Link>
                  <Link
                    href={`${base}/payments/new?customerId=${customerId}`}
                    className={buttonClass('secondary', 'sm')}
                  >
                    Receive payment
                  </Link>
                  <Link
                    href={`${base}/estimates/new?customerId=${customerId}`}
                    className={buttonClass('secondary', 'sm')}
                  >
                    New estimate
                  </Link>
                </>
              )}
              <Button variant="secondary" size="sm" onClick={() => setStatement(true)}>
                Statement
              </Button>
            </div>
          </div>
        </Card>
        <Card className="p-5">
          <dl className="space-y-2 text-sm" data-testid="customer-balances">
            <div className="flex justify-between">
              <dt className="text-gray-500">Open balance</dt>
              <dd className="font-semibold tabular-nums">
                ${formatMoney(balance.data?.openBalance ?? '0')}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Overdue</dt>
              <dd className="tabular-nums text-amber-700">
                ${formatMoney(balance.data?.overdueBalance ?? '0')}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Available credit</dt>
              <dd className="tabular-nums">${formatMoney(balance.data?.availableCredit ?? '0')}</dd>
            </div>
          </dl>
        </Card>
      </div>
      <SalesTransactionsTable companyId={companyId} customerId={customerId} />
      <Dialog open={statement} onClose={() => setStatement(false)} title="Customer statement">
        <form onSubmit={openStatement} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <TextInput
              label="Start date"
              name="from"
              type="date"
              defaultValue={addDays(todayIso(), -30)}
              required
            />
            <TextInput label="End date" name="to" type="date" defaultValue={todayIso()} required />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setStatement(false)}>
              Cancel
            </Button>
            <Button type="submit">View statement</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
