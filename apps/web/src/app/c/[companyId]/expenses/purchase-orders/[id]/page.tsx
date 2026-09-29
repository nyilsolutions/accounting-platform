'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { todayIso, type PurchaseDocumentDto, type PurchaseOrderDto } from '@acct/shared';
import { useClosingPassword } from '@/components/ledger/closing-password';
import { PurchaseOrderForm } from '@/components/purchases/purchase-order-form';
import { useSalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Badge, Button, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, ledgerKeys, useAccess } from '@/lib/queries';

export default function PurchaseOrderPage() {
  const { companyId, id } = useParams<{ companyId: string; id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const { ready, lookups } = useSalesLookups(companyId);
  const closing = useClosingPassword();
  const [error, setError] = useState<string | null>(null);
  const po = useQuery({
    queryKey: keys.salesDoc(companyId, 'purchase-orders', id),
    queryFn: () => api<PurchaseOrderDto>(`/companies/${companyId}/purchase-orders/${id}`),
  });
  if (po.isError) return <Alert>{errorMessage(po.error)}</Alert>;
  if (!ready || po.isPending) return <Spinner />;
  const p = po.data;
  const canManage = access.can('purchases.manage');
  const refresh = () => qc.invalidateQueries({ queryKey: keys.sales(companyId) });

  async function run(fn: () => Promise<void>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-gray-600">
        <Link
          href={`/c/${companyId}/expenses/purchase-orders`}
          className="text-brand-700 hover:underline"
        >
          ← Purchase orders
        </Link>
        <span className="font-medium text-gray-900">
          Purchase order {p.number ? `#${p.number}` : ''}
        </span>
        <span>{p.vendorName}</span>
        <Badge tone={p.status === 'open' ? 'gray' : 'green'}>
          {p.billId ? 'Billed' : p.status === 'open' ? 'Open' : 'Closed'}
        </Badge>
        {p.billId && (
          <Link
            href={`/c/${companyId}/expenses/bills/${p.billId}`}
            className="text-brand-700 hover:underline"
          >
            View bill
          </Link>
        )}
      </div>
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}
      <PurchaseOrderForm
        key={JSON.stringify([p.status, p.total, p.txnDate, p.number])}
        initial={p}
        lookups={lookups}
        readOnly={!canManage || !!p.billId}
        onSave={async (input, andNew) => {
          await api(`/companies/${companyId}/purchase-orders/${id}`, {
            method: 'PUT',
            body: input,
          });
          await refresh();
          router.push(
            andNew
              ? `/c/${companyId}/expenses/purchase-orders/new`
              : `/c/${companyId}/expenses/purchase-orders`,
          );
        }}
        footer={
          canManage &&
          !p.billId && (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() =>
                  run(() =>
                    closing.run(async (closingPassword) => {
                      const bill = await api<PurchaseDocumentDto>(
                        `/companies/${companyId}/purchase-orders/${id}/convert`,
                        {
                          method: 'POST',
                          body: { txnDate: todayIso(), closingPassword },
                        },
                      );
                      await Promise.all(
                        ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })),
                      );
                      router.push(`/c/${companyId}/expenses/bills/${bill.id}`);
                    }),
                  )
                }
              >
                Copy to bill
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() =>
                  run(async () => {
                    await api(`/companies/${companyId}/purchase-orders/${id}/status`, {
                      method: 'POST',
                      body: { status: p.status === 'open' ? 'closed' : 'open' },
                    });
                    await refresh();
                  })
                }
              >
                {p.status === 'open' ? 'Close' : 'Reopen'}
              </Button>
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() =>
                  confirm('Delete this purchase order?') &&
                  run(async () => {
                    await api(`/companies/${companyId}/purchase-orders/${id}`, {
                      method: 'DELETE',
                    });
                    await refresh();
                    router.push(`/c/${companyId}/expenses/purchase-orders`);
                  })
                }
              >
                Delete
              </Button>
            </div>
          )
        }
      />
      {closing.dialog}
    </>
  );
}
