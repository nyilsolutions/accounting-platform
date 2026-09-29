'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatMoney, type PaymentDto } from '@acct/shared';
import { useClosingPassword } from '@/components/ledger/closing-password';
import { PaymentForm } from '@/components/sales/payment-form';
import { useSalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Badge, Button, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, ledgerKeys, useAccess } from '@/lib/queries';
import { Attachments } from '@/components/documents/attachments';

export default function PaymentPage() {
  const { companyId, id } = useParams<{ companyId: string; id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const { ready, lookups } = useSalesLookups(companyId);
  const closing = useClosingPassword();
  const [error, setError] = useState<string | null>(null);
  const payment = useQuery({
    queryKey: keys.salesDoc(companyId, 'payments', id),
    queryFn: () => api<PaymentDto>(`/companies/${companyId}/payments/${id}`),
  });
  if (payment.isError) return <Alert>{errorMessage(payment.error)}</Alert>;
  if (!ready || payment.isPending) return <Spinner />;
  const p = payment.data;
  const canManage = access.can('sales.manage');
  const refresh = () =>
    Promise.all(ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })));

  async function action(path: string, method: string, text: string) {
    if (!confirm(text)) return;
    setError(null);
    try {
      await closing.run(async (closingPassword) => {
        await api(`/companies/${companyId}/payments/${id}${path}`, {
          method,
          body: { closingPassword },
        });
        await refresh();
        router.push(`/c/${companyId}/sales`);
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-gray-600">
        <Link href={`/c/${companyId}/sales`} className="text-brand-700 hover:underline">
          ← Sales
        </Link>
        <span className="font-medium text-gray-900">
          Payment · {p.customerName} · {formatMoney(p.amount)}
        </span>
        {p.status === 'void' && <Badge tone="amber">Void</Badge>}
        {p.depositId && (
          <Link
            href={`/c/${companyId}/sales/deposits/${p.depositId}`}
            className="text-brand-700 hover:underline"
          >
            <Badge tone="green">Deposited</Badge>
          </Link>
        )}
      </div>
      {p.depositId && (
        <div className="mb-4">
          <Alert kind="info">
            This payment is in a bank deposit, so its amount and account are locked. Remove it from
            the deposit to change them.
          </Alert>
        </div>
      )}
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}
      <PaymentForm
        key={p.version}
        companyId={companyId}
        initial={p}
        lookups={lookups}
        readOnly={!canManage || p.status !== 'posted'}
        onSave={(input, andNew) =>
          closing.run(async (closingPassword) => {
            await api(`/companies/${companyId}/payments/${id}`, {
              method: 'PUT',
              body: { ...input, closingPassword },
            });
            await refresh();
            router.push(andNew ? `/c/${companyId}/sales/payments/new` : `/c/${companyId}/sales`);
          })
        }
        footer={
          canManage && (
            <div className="flex gap-2">
              {p.status === 'posted' && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    action(
                      '/void',
                      'POST',
                      'Void this payment? The invoices it paid become open again.',
                    )
                  }
                >
                  Void
                </Button>
              )}
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() =>
                  action(
                    '',
                    'DELETE',
                    'Delete this payment? The invoices it paid become open again.',
                  )
                }
              >
                Delete
              </Button>
              <Link
                href={`/c/${companyId}/settings/audit-log?entity=${id}`}
                className="self-center text-xs text-gray-500 hover:underline"
              >
                History
              </Link>
            </div>
          )
        }
      />
      <Attachments companyId={companyId} entityType="transaction" entityId={id} />
      {closing.dialog}
    </>
  );
}
