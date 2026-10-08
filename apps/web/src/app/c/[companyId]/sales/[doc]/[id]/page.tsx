'use client';

import Link from 'next/link';
import { notFound, useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatDate,
  formatMoney,
  parseMoney,
  moneyToString,
  SALES_DOC_BY_SLUG,
  TXN_TYPE_LABELS,
  type SalesDocumentDto,
} from '@acct/shared';
import { useClosingPassword } from '@/components/ledger/closing-password';
import { DocumentPrint } from '@/components/sales/document-print';
import { DOC_LABELS, SalesDocumentForm } from '@/components/sales/sales-document-form';
import { SendDialog } from '@/components/sales/send-dialog';
import { PaymentStatusBadge } from '@/components/sales/status-badge';
import { useSalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Button, buttonClass, Card, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { txnHref } from '@/lib/links';
import { keys, ledgerKeys, useAccess } from '@/lib/queries';

function SalesDocument() {
  const { companyId, doc, id } = useParams<{ companyId: string; doc: string; id: string }>();
  const type = SALES_DOC_BY_SLUG[doc];
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const { ready, lookups } = useSalesLookups(companyId);
  const closing = useClosingPassword();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(params.get('send') === '1');
  const document = useQuery({
    queryKey: keys.salesDoc(companyId, doc, id),
    queryFn: () => api<SalesDocumentDto>(`/companies/${companyId}/sales/${doc}/${id}`),
    enabled: !!type,
  });
  if (!type) notFound();
  if (document.isError) return <Alert>{errorMessage(document.error)}</Alert>;
  if (!ready || document.isPending) return <Spinner />;
  const d = document.data;
  const labels = DOC_LABELS[type];
  const canManage = access.can('sales.manage');
  const url = `/c/${companyId}/sales/${doc}/${id}`;
  const refresh = () =>
    Promise.all(ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })));

  async function action(path: string, method: string, confirmText: string) {
    if (!confirm(confirmText)) return;
    setError(null);
    try {
      await closing.run(async (closingPassword) => {
        await api(`/companies/${companyId}/sales/${doc}/${id}${path}`, {
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

  const itemName = (itemId: string | null, accountId: string) =>
    itemId
      ? (d.lines.find((l) => l.itemId === itemId)?.itemName ?? '')
      : (lookups.accounts.find((a) => a.id === accountId)?.name ?? '');

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-gray-600 print:hidden">
        <Link href={`/c/${companyId}/sales`} className="text-brand-700 hover:underline">
          ← Sales
        </Link>
        <span className="font-medium text-gray-900">
          {labels.title} {d.number ? `#${d.number}` : ''}
        </span>
        <span>{d.customerName}</span>
        <PaymentStatusBadge status={d.paymentStatus} />
        {d.sentAt && (
          <span className="text-xs text-gray-500">Sent {new Date(d.sentAt).toLocaleString()}</span>
        )}
        <span className="text-xs text-gray-400">Version {d.version}</span>
      </div>
      {d.status === 'void' && (
        <div className="mb-4 print:hidden">
          <Alert kind="info">
            This {labels.title.toLowerCase()} is void. It is kept for your records but has no effect
            on balances.
          </Alert>
        </div>
      )}
      {(error || notice) && (
        <div className="mb-4 print:hidden">
          {error ? <Alert>{error}</Alert> : <Alert kind="success">{notice}</Alert>}
        </div>
      )}
      {d.applied.length > 0 && (
        <Card className="mb-4 p-4 text-sm print:hidden">
          <h3 className="mb-2 font-medium text-gray-900">
            {type === 'invoice' ? 'Payments and credits applied' : 'Applied to'}
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
      <SalesDocumentForm
        key={d.version}
        type={type}
        initial={d}
        lookups={lookups}
        readOnly={!canManage || d.status !== 'posted'}
        onSave={(input, act) =>
          closing.run(async (closingPassword) => {
            await api(`/companies/${companyId}/sales/${doc}/${id}`, {
              method: 'PUT',
              body: { ...input, closingPassword },
            });
            await refresh();
            if (act === 'new') router.push(`/c/${companyId}/sales/${doc}/new`);
            else if (act === 'send') setSending(true);
            else router.push(`/c/${companyId}/sales`);
          })
        }
        footer={
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => window.print()}>
              Print or save PDF
            </Button>
            {canManage && d.status === 'posted' && (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setSending(true)}
                >
                  Email
                </Button>
                {type === 'invoice' && d.balance !== '0.00' && (
                  <Link
                    href={`/c/${companyId}/sales/payments/new?customerId=${d.customerId}&invoiceId=${d.id}`}
                    className={buttonClass('secondary', 'sm')}
                  >
                    Receive payment
                  </Link>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    action(
                      '/void',
                      'POST',
                      `Void this ${labels.title.toLowerCase()}? It stays on record with a zero amount.`,
                    )
                  }
                >
                  Void
                </Button>
              </>
            )}
            {canManage && (
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
            )}
            <Link
              href={`/c/${companyId}/settings/audit-log?entity=${id}`}
              className="text-xs text-gray-500 hover:underline"
            >
              History
            </Link>
          </div>
        }
      />
      <DocumentPrint
        company={lookups.company}
        doc={{
          title: labels.title,
          number: d.number,
          txnDate: d.txnDate,
          dueDate: d.dueDate,
          billTo: d.billTo,
          customerName: d.customerName,
          reference: d.reference,
          lines: d.lines.map((l) => ({
            serviceDate: l.serviceDate,
            name: itemName(l.itemId, l.accountId),
            description: l.description,
            quantity: l.quantity,
            rate: l.rate,
            amount: l.amount,
          })),
          total: d.total,
          ...(type === 'invoice'
            ? {
                paid: moneyToString(parseMoney(d.total) - parseMoney(d.balance)),
                balance: d.balance,
              }
            : {}),
          message: d.customerMessage,
        }}
      />
      <SendDialog
        open={sending}
        onClose={() => {
          setSending(false);
          router.replace(url);
        }}
        title={`Email ${labels.title.toLowerCase()} ${d.number ?? ''}`}
        defaultTo={d.emailTo}
        onSend={async (input) => {
          await api(`/companies/${companyId}/sales/${doc}/${id}/send`, {
            method: 'POST',
            body: input,
          });
          await qc.invalidateQueries({ queryKey: keys.sales(companyId) });
          setNotice(`${labels.title} sent to ${input.to}.`);
        }}
      />
      {closing.dialog}
    </>
  );
}

export default function SalesDocumentPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <SalesDocument />
    </Suspense>
  );
}
