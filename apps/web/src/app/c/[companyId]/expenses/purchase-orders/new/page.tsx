'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PurchaseOrderDto } from '@acct/shared';
import { PurchaseOrderForm } from '@/components/purchases/purchase-order-form';
import { useSalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';

function NewPurchaseOrder() {
  const { companyId } = useParams<{ companyId: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const { ready, lookups } = useSalesLookups(companyId);
  const [saved, setSaved] = useState<string | null>(null);
  const next = useQuery({
    queryKey: [...keys.sales(companyId), 'purchase-orders', 'next-number', saved],
    queryFn: () => api<{ number: string }>(`/companies/${companyId}/purchase-orders/next-number`),
  });
  if (!ready || next.isPending) return <Spinner />;
  return (
    <>
      <h2 className="mb-4 text-xl font-semibold text-gray-900">New purchase order</h2>
      {saved && (
        <div className="mb-4">
          <Alert kind="success">Purchase order {saved} saved.</Alert>
        </div>
      )}
      <PurchaseOrderForm
        key={saved ?? 'new'}
        lookups={lookups}
        suggestedNumber={next.data?.number}
        defaultVendorId={params.get('vendorId') ?? undefined}
        onSave={async (input, andNew) => {
          const po = await api<PurchaseOrderDto>(`/companies/${companyId}/purchase-orders`, {
            method: 'POST',
            body: input,
          });
          await qc.invalidateQueries({ queryKey: keys.sales(companyId) });
          if (andNew) setSaved(po.number ?? '');
          else router.push(`/c/${companyId}/expenses/purchase-orders`);
        }}
      />
    </>
  );
}

export default function NewPurchaseOrderPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <NewPurchaseOrder />
    </Suspense>
  );
}
