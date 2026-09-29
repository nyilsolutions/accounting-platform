'use client';

import Link from 'next/link';
import { notFound, useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatDate,
  formatMoney,
  PURCHASE_DOC_BY_SLUG,
  TXN_TYPE_LABELS,
  type PurchaseDocumentDto,
} from '@acct/shared';
import { useClosingPassword } from '@/components/ledger/closing-password';
import {
  PURCHASE_LABELS,
  PurchaseDocumentForm,
} from '@/components/purchases/purchase-document-form';
import { PaymentStatusBadge } from '@/components/sales/status-badge';
import { useSalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Badge, Button, buttonClass, Card, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { txnHref } from '@/lib/links';
import { keys, ledgerKeys, useAccess } from '@/lib/queries';
import { Attachments } from '@/components/documents/attachments';

export default function PurchaseDocumentPage() {
  const { companyId, doc, id } = useParams<{ companyId: string; doc: string; id: string }>();
  const type = PURCHASE_DOC_BY_SLUG[doc];
  const router = useRouter();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const { ready, lookups } = useSalesLookups(companyId);
  const closing = useClosingPassword();
  const [error, setError] = useState<string | null>(null);
  const document = useQuery({
    queryKey: keys.salesDoc(companyId, doc, id),
    queryFn: () => api<PurchaseDocumentDto>(`/companies/${companyId}/purchases/${doc}/${id}`),
    enabled: !!type,
  });
  if (!type) notFound();
  if (document.isError) return <Alert>{errorMessage(document.error)}</Alert>;
  if (!ready || document.isPending) return <Spinner />;
  const d = document.data;
  const labels = PURCHASE_LABELS[type];
  const canManage = access.can('purchases.manage');
  const refresh = () =>
    Promise.all(ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })));

  async function action(path: string, method: string, text: string) {
    if (!confirm(text)) return;
    setError(null);
    try {
      await closing.run(async (closingPassword) => {
        await api(`/companies/${companyId}/purchases/${doc}/${id}${path}`, {
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
          {labels.title} {d.number ? `#${d.number}` : ''}
        </span>
        <span>{d.vendorName}</span>
        {(type === 'bill' || type === 'vendor_credit' || d.status === 'void') && (
          <PaymentStatusBadge status={d.paymentStatus} />
        )}
        {d.printStatus === 'to_print' && <Badge tone="amber">To print</Badge>}
        <span className="text-xs text-gray-400">Version {d.version}</span>
      </div>
      {d.status === 'void' && (
        <div className="mb-4">
          <Alert kind="info">
            This {labels.title.toLowerCase()} is void. It is kept for your records but has no effect
            on balances.
          </Alert>
        </div>
      )}
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}
      {d.applied.length > 0 && (
        <Card className="mb-4 p-4 text-sm">
          <h3 className="mb-2 font-medium text-gray-900">
            {type === 'bill' ? 'Payments' : 'Used in bill payments'}
          </h3>
          <ul className="space-y-1">
            {d.applied.map((a) => (
              <li key={a.txnId} className="flex justify-between gap-4">
                <Link
                  href={txnHref(companyId, a.txnType, a.txnId)}
                  className="text-brand-700 hover:underline"
                >
                  {TXN_TYPE_LABELS[a.txnType]} {a.number ?? ''} · {formatDate(a.txnDate)}
                </Link>
                <span className="tabular-nums">{formatMoney(a.amount)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <PurchaseDocumentForm
        key={d.version}
        companyId={companyId}
        type={type}
        initial={d}
        lookups={lookups}
        readOnly={!canManage || d.status !== 'posted'}
        onSave={(input, andNew) =>
          closing.run(async (closingPassword) => {
            await api(`/companies/${companyId}/purchases/${doc}/${id}`, {
              method: 'PUT',
              body: { ...input, closingPassword },
            });
            await refresh();
            router.push(
              andNew ? `/c/${companyId}/expenses/${doc}/new` : `/c/${companyId}/expenses`,
            );
          })
        }
        footer={
          canManage && (
            <div className="flex flex-wrap items-center gap-2">
              {type === 'bill' && d.status === 'posted' && d.balance !== '0.00' && (
                <Link
                  href={`/c/${companyId}/expenses/pay-bills?vendorId=${d.vendorId}`}
                  className={buttonClass('secondary', 'sm')}
                >
                  Pay bill
                </Link>
              )}
              {d.status === 'posted' && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    action(
                      '/void',
                      'POST',
                      `Void this ${labels.title.toLowerCase()}? It stays on record with no effect on balances.`,
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
                    `Delete this ${labels.title.toLowerCase()}? It will be removed from all lists and reports.`,
                  )
                }
              >
                Delete
              </Button>
              <Link
                href={`/c/${companyId}/settings/audit-log?entity=${id}`}
                className="text-xs text-gray-500 hover:underline"
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
