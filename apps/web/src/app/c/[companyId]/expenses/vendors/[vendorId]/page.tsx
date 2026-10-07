'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { formatMoney, type VendorBalanceDto, type VendorDto } from '@acct/shared';
import { PurchaseTransactionsTable } from '@/components/purchases/transactions-table';
import { billToOf } from '@/components/sales/use-sales-lookups';
import { Alert, Badge, buttonClass, Card, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, useAccess } from '@/lib/queries';
import { Attachments } from '@/components/documents/attachments';
import { PortalAccessCard } from '@/components/portal/portal-access-card';

export default function VendorPage() {
  const { companyId, vendorId } = useParams<{ companyId: string; vendorId: string }>();
  const access = useAccess(companyId);
  const vendor = useQuery({
    queryKey: ['company', companyId, 'vendors', 'one', vendorId],
    queryFn: () => api<VendorDto>(`/companies/${companyId}/vendors/${vendorId}`),
  });
  const balance = useQuery({
    queryKey: [...keys.sales(companyId), 'vendor-balances', vendorId],
    queryFn: async () =>
      (
        await api<VendorBalanceDto[]>(
          `/companies/${companyId}/vendor-balances?vendorId=${vendorId}`,
        )
      )[0],
  });
  if (vendor.isError) return <Alert>{errorMessage(vendor.error)}</Alert>;
  if (vendor.isPending) return <Spinner />;
  const v = vendor.data;
  const base = `/c/${companyId}/expenses`;
  const canManage = access.can('purchases.manage');

  return (
    <>
      <div className="mb-4 text-sm">
        <Link href={`${base}/vendors`} className="text-brand-700 hover:underline">
          ← Vendors
        </Link>
      </div>
      <div className="mb-5 grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2
                className="flex items-center gap-2 text-xl font-semibold text-gray-900"
                data-testid="vendor-name"
              >
                {v.displayName} {v.is1099 && <Badge tone="green">1099</Badge>}
              </h2>
              <div className="mt-2 whitespace-pre-line text-sm text-gray-600">{billToOf(v)}</div>
              <div className="mt-1 text-sm text-gray-600">
                {[v.email, v.phone, v.tinMasked ? `TIN ${v.tinMasked}` : null]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            {canManage && (
              <div className="flex flex-wrap gap-2">
                <Link
                  href={`${base}/bills/new?vendorId=${vendorId}`}
                  className={buttonClass('primary', 'sm')}
                >
                  New bill
                </Link>
                <Link
                  href={`${base}/pay-bills?vendorId=${vendorId}`}
                  className={buttonClass('secondary', 'sm')}
                >
                  Pay bills
                </Link>
                <Link
                  href={`${base}/checks/new?vendorId=${vendorId}`}
                  className={buttonClass('secondary', 'sm')}
                >
                  Write check
                </Link>
                <Link
                  href={`${base}/purchase-orders/new?vendorId=${vendorId}`}
                  className={buttonClass('secondary', 'sm')}
                >
                  New purchase order
                </Link>
              </div>
            )}
          </div>
        </Card>
        <Card className="p-5">
          <dl className="space-y-2 text-sm" data-testid="vendor-balances">
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
              <dt className="text-gray-500">Vendor credits</dt>
              <dd className="tabular-nums">${formatMoney(balance.data?.availableCredit ?? '0')}</dd>
            </div>
          </dl>
        </Card>
      </div>
      <div className="mt-6">
        <PortalAccessCard
          companyId={companyId}
          kind="contractor"
          workerId={vendorId}
          defaultEmail={v.email}
          canManage={canManage}
        />
      </div>
      <PurchaseTransactionsTable companyId={companyId} vendorId={vendorId} />
      <Attachments companyId={companyId} entityType="vendor" entityId={vendorId} />
    </>
  );
}
