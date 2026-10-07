'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  formatMoney,
  ONLINE_PAYMENT_METHOD_LABELS,
  type OnlinePaymentsActivityDto,
  type PayLinkDto,
  type SalesDocumentDto,
} from '@acct/shared';
import { Alert, Button, Card } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, useOnlinePayments } from '@/lib/queries';

const STATUS: Record<string, string> = {
  started: 'checkout opened',
  processing: 'on its way',
  succeeded: 'paid',
  failed: 'failed',
  canceled: 'abandoned',
};

/** On an invoice: its link to pay online, and what was paid through it (ADR 0022). */
export function InvoiceOnlinePayments({
  companyId,
  invoice,
  canManage,
}: {
  companyId: string;
  invoice: SalesDocumentDto;
  canManage: boolean;
}) {
  const settings = useOnlinePayments(companyId);
  const activity = useQuery({
    queryKey: [...keys.onlinePayments(companyId), 'invoice', invoice.id],
    queryFn: () =>
      api<OnlinePaymentsActivityDto>(
        `/companies/${companyId}/online-payments/activity?invoiceId=${invoice.id}`,
      ),
  });
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const account = settings.data?.account;
  const canLink =
    canManage &&
    account?.status === 'active' &&
    invoice.status === 'posted' &&
    !invoice.currency &&
    invoice.balance !== '0.00';
  const payments = (activity.data?.payments ?? []).filter((p) => p.status !== 'canceled');
  if (!canLink && payments.length === 0) return null;

  async function makeLink() {
    setError(null);
    try {
      const r = await api<PayLinkDto>(
        `/companies/${companyId}/sales/invoices/${invoice.id}/pay-link`,
        {
          method: 'POST',
        },
      );
      setLink(r.url);
      setCopied(false);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Card className="mb-4 p-4 text-sm print:hidden" data-testid="invoice-online-payments">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium text-gray-900">Online payment</h3>
        {canLink && !link && (
          <Button type="button" size="sm" variant="secondary" onClick={makeLink}>
            Get payment link
          </Button>
        )}
      </div>
      {error && (
        <div className="mt-2">
          <Alert>{error}</Alert>
        </div>
      )}
      {link && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            readOnly
            aria-label="Payment link"
            value={link}
            className="min-w-0 flex-1 rounded-md border border-gray-300 px-2 py-1 font-mono text-xs"
            onFocus={(e) => e.target.select()}
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={async () => {
              await navigator.clipboard?.writeText(link).catch(() => undefined);
              setCopied(true);
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      )}
      {canLink && !link && (
        <p className="mt-1 text-gray-600">
          Emailing the invoice includes a link to pay by card or bank transfer.
        </p>
      )}
      {payments.length > 0 && (
        <ul className="mt-2 space-y-1">
          {payments.map((p) => (
            <li key={p.id} className="flex justify-between gap-4">
              <span>
                {p.method ? ONLINE_PAYMENT_METHOD_LABELS[p.method] : 'Online'} · {STATUS[p.status]}{' '}
                · {new Date(p.createdAt).toLocaleDateString()}
                {p.failureMessage && <span className="text-gray-500"> ({p.failureMessage})</span>}
              </span>
              <span className="tabular-nums">{formatMoney(p.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
