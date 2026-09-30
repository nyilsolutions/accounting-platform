'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { todayIso, type EstimateDto, type SalesDocumentDto } from '@acct/shared';
import { useClosingPassword } from '@/components/ledger/closing-password';
import { DocumentPrint } from '@/components/sales/document-print';
import { EstimateForm } from '@/components/sales/estimate-form';
import { SendDialog } from '@/components/sales/send-dialog';
import { EstimateProgress, ProgressInvoiceDialog } from '@/components/sales/progress-invoice';
import { EstimateStatusBadge } from '@/components/sales/status-badge';
import { useSalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Button, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, ledgerKeys, useAccess } from '@/lib/queries';

export default function EstimatePage() {
  const { companyId, id } = useParams<{ companyId: string; id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const { ready, lookups } = useSalesLookups(companyId);
  const closing = useClosingPassword();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState(false);
  const estimate = useQuery({
    queryKey: keys.salesDoc(companyId, 'estimates', id),
    queryFn: () => api<EstimateDto>(`/companies/${companyId}/estimates/${id}`),
  });
  if (estimate.isError) return <Alert>{errorMessage(estimate.error)}</Alert>;
  if (!ready || estimate.isPending) return <Spinner />;
  const e = estimate.data;
  const canManage = access.can('sales.manage');
  const converted = !!e.invoiceId;
  const partly = e.progressInvoices.length > 0;
  const open = !converted && e.remainingTotal !== '0.00';
  const refresh = () => qc.invalidateQueries({ queryKey: keys.sales(companyId) });

  async function run(fn: () => Promise<void>) {
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const setStatus = (status: 'pending' | 'accepted' | 'rejected') =>
    run(async () => {
      await api(`/companies/${companyId}/estimates/${id}/status`, {
        method: 'POST',
        body: { status },
      });
      await refresh();
    });

  const convert = () =>
    run(() =>
      closing.run(async (closingPassword) => {
        const inv = await api<SalesDocumentDto>(`/companies/${companyId}/estimates/${id}/convert`, {
          method: 'POST',
          body: { txnDate: todayIso(), closingPassword },
        });
        await Promise.all(ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })));
        router.push(`/c/${companyId}/sales/invoices/${inv.id}`);
      }),
    );

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-gray-600 print:hidden">
        <Link href={`/c/${companyId}/sales/estimates`} className="text-brand-700 hover:underline">
          ← Estimates
        </Link>
        <span className="font-medium text-gray-900">Estimate {e.number ? `#${e.number}` : ''}</span>
        <span>{e.customerName}</span>
        <EstimateStatusBadge status={e.status} />
        {e.invoiceId && (
          <Link
            href={`/c/${companyId}/sales/invoices/${e.invoiceId}`}
            className="text-brand-700 hover:underline"
          >
            View invoice
          </Link>
        )}
      </div>
      {(error || notice) && (
        <div className="mb-4 print:hidden">
          {error ? <Alert>{error}</Alert> : <Alert kind="success">{notice}</Alert>}
        </div>
      )}
      <EstimateForm
        key={JSON.stringify([e.status, e.total, e.txnDate, e.number])}
        initial={e}
        lookups={lookups}
        readOnly={!canManage || converted || partly}
        onSave={async (input, andNew) => {
          await api(`/companies/${companyId}/estimates/${id}`, { method: 'PUT', body: input });
          await refresh();
          router.push(
            andNew ? `/c/${companyId}/sales/estimates/new` : `/c/${companyId}/sales/estimates`,
          );
        }}
        footer={
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => window.print()}>
              Print or save PDF
            </Button>
            {canManage && open && (
              <Button
                type="button"
                variant={partly ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setProgress(true)}
              >
                Create progress invoice
              </Button>
            )}
            {canManage && !converted && !partly && (
              <>
                <Button type="button" size="sm" onClick={convert}>
                  Convert to invoice
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setSending(true)}
                >
                  Email
                </Button>
                {e.status !== 'accepted' && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setStatus('accepted')}
                  >
                    Mark accepted
                  </Button>
                )}
                {e.status !== 'rejected' && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setStatus('rejected')}
                  >
                    Mark rejected
                  </Button>
                )}
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  onClick={() =>
                    confirm('Delete this estimate?') &&
                    run(async () => {
                      await api(`/companies/${companyId}/estimates/${id}`, { method: 'DELETE' });
                      await refresh();
                      router.push(`/c/${companyId}/sales/estimates`);
                    })
                  }
                >
                  Delete
                </Button>
              </>
            )}
          </div>
        }
      />
      <EstimateProgress
        estimate={e}
        invoiceHref={(inv) => `/c/${companyId}/sales/invoices/${inv}`}
      />
      <ProgressInvoiceDialog
        open={progress}
        estimate={e}
        onClose={() => setProgress(false)}
        onCreate={(input) =>
          closing.run(async (closingPassword) => {
            const inv = await api<SalesDocumentDto>(
              `/companies/${companyId}/estimates/${id}/progress-invoice`,
              { method: 'POST', body: { ...input, closingPassword } },
            );
            await Promise.all(
              ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })),
            );
            router.push(`/c/${companyId}/sales/invoices/${inv.id}`);
          })
        }
      />
      <DocumentPrint
        company={lookups.company}
        doc={{
          title: 'Estimate',
          number: e.number,
          txnDate: e.txnDate,
          expirationDate: e.expirationDate,
          billTo: e.billTo,
          customerName: e.customerName,
          lines: e.lines.map((l) => ({
            serviceDate: l.serviceDate,
            name: l.itemName ?? lookups.accounts.find((a) => a.id === l.accountId)?.name ?? null,
            description: l.description,
            quantity: l.quantity,
            rate: l.rate,
            amount: l.amount,
          })),
          total: e.total,
          message: e.customerMessage,
        }}
      />
      <SendDialog
        open={sending}
        onClose={() => setSending(false)}
        title={`Email estimate ${e.number ?? ''}`}
        defaultTo={e.emailTo}
        onSend={async (input) => {
          await api(`/companies/${companyId}/estimates/${id}/send`, {
            method: 'POST',
            body: input,
          });
          await refresh();
          setNotice(`Estimate sent to ${input.to}.`);
        }}
      />
      {closing.dialog}
    </>
  );
}
