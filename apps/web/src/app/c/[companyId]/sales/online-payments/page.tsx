'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatDate,
  formatMoney,
  ONLINE_PAYMENT_METHOD_LABELS,
  todayIso,
  type OnlinePaymentDto,
  type OnlinePaymentsActivityDto,
  type PayoutDto,
} from '@acct/shared';
import { Alert, Badge, Button, Card, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { txnHref } from '@/lib/links';
import { keys, ledgerKeys, useAccess, useOnlinePayments } from '@/lib/queries';

const PAYMENT_STATUS: Record<
  OnlinePaymentDto['status'],
  { label: string; tone: 'green' | 'amber' | 'gray' | 'red' }
> = {
  started: { label: 'Checkout opened', tone: 'gray' },
  processing: { label: 'On its way', tone: 'amber' },
  succeeded: { label: 'Paid', tone: 'green' },
  failed: { label: 'Failed', tone: 'red' },
  canceled: { label: 'Abandoned', tone: 'gray' },
};

const PAYOUT_STATUS: Record<
  PayoutDto['status'],
  { label: string; tone: 'green' | 'amber' | 'red' }
> = {
  recorded: { label: 'Deposited', tone: 'green' },
  review: { label: 'Needs review', tone: 'amber' },
  failed: { label: 'Returned', tone: 'red' },
};

/** Sales › Online payments: what customers paid online and the payouts that reached the bank. */
export default function OnlinePaymentsPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const settings = useOnlinePayments(companyId);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const activity = useQuery({
    queryKey: [...keys.onlinePayments(companyId), 'activity'],
    queryFn: () =>
      api<OnlinePaymentsActivityDto>(`/companies/${companyId}/online-payments/activity`),
  });
  const canManage = access.can('sales.manage');
  const standIn = settings.data?.provider === 'mock';
  const accountId = settings.data?.account?.accountId;

  async function run(fn: () => Promise<unknown>, message: string) {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(message);
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.onlinePayments(companyId) }),
        ...ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })),
      ]);
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  /** The stand-in's own controls: what Stripe would do on its side. */
  const standInAction = (body: object, message: string) =>
    run(() => api('/webhooks/payments/mock', { method: 'POST', body }), message);

  if (activity.isPending || settings.isPending) return <Spinner />;
  if (activity.isError) return <Alert>{errorMessage(activity.error)}</Alert>;
  const { payments, payouts } = activity.data;

  return (
    <div className="space-y-6" data-testid="online-payments">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Online payments</h2>
          <p className="text-sm text-gray-600">
            Invoices paid from the link in the invoice email. Paid amounts wait in Undeposited Funds
            until the payout that carries them is deposited.
          </p>
        </div>
        {!settings.data?.account || settings.data.account.status === 'disconnected' ? (
          <Link
            href={`/c/${companyId}/settings#online-payments`}
            className="text-sm text-brand-700 hover:underline"
          >
            Set up online payments →
          </Link>
        ) : (
          standIn &&
          canManage &&
          accountId && (
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                standInAction(
                  { action: 'payout', accountId, arrivalDate: todayIso() },
                  'The stand-in paid out what it collected.',
                )
              }
            >
              Pay out now (stand-in)
            </Button>
          )
        )}
      </div>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}

      <section>
        <h3 className="mb-2 font-medium text-gray-900">Payments</h3>
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full min-w-[760px] text-sm" data-testid="online-payment-list">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Invoice</th>
                <th className="px-3 py-2">Customer</th>
                <th className="px-3 py-2">Paid by</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {payments.map((p) => (
                <tr key={p.id} className="align-top">
                  <td className="px-3 py-2">
                    {new Date(p.succeededAt ?? p.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      href={`/c/${companyId}/sales/invoices/${p.invoiceId}`}
                      className="text-brand-700 hover:underline"
                    >
                      {p.invoiceNumber ?? 'Invoice'}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{p.customerName}</td>
                  <td className="px-3 py-2">
                    {p.method ? ONLINE_PAYMENT_METHOD_LABELS[p.method] : '—'}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      <Badge tone={PAYMENT_STATUS[p.status].tone}>
                        {PAYMENT_STATUS[p.status].label}
                      </Badge>
                      {p.refunded !== '0.00' && (
                        <Badge tone="gray">Refunded {formatMoney(p.refunded)}</Badge>
                      )}
                      {p.disputeStatus && (
                        <Badge tone={p.disputeStatus === 'lost' ? 'red' : 'amber'}>
                          Dispute {p.disputeStatus}
                        </Badge>
                      )}
                    </div>
                    {p.failureMessage && (
                      <p className="mt-1 max-w-sm text-xs text-gray-600">{p.failureMessage}</p>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(p.amount)}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex flex-wrap justify-end gap-2">
                      {p.paymentTxnId && (
                        <Link
                          href={txnHref(companyId, 'payment', p.paymentTxnId)}
                          className="text-xs text-brand-700 hover:underline"
                        >
                          Payment
                        </Link>
                      )}
                      {canManage && !p.paymentTxnId && p.failureMessage?.startsWith('Received') && (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            run(
                              () =>
                                api(
                                  `/companies/${companyId}/online-payments/payments/${p.id}/record`,
                                  { method: 'POST' },
                                ),
                              'Payment recorded.',
                            )
                          }
                        >
                          Record now
                        </Button>
                      )}
                      {standIn && canManage && p.paymentIntentId && (
                        <StandInControls payment={p} act={standInAction} />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {payments.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                    No online payments yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3 className="mb-2 font-medium text-gray-900">Payouts</h3>
        {payouts.length === 0 ? (
          <Card className="p-6 text-sm text-gray-600">No payouts yet.</Card>
        ) : (
          <Card className="divide-y divide-gray-100" data-testid="payout-list">
            {payouts.map((p) => (
              <div key={p.id} className="p-4 text-sm" data-testid="payout">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-medium">{formatDate(p.arrivalDate)}</span>
                  <span className="tabular-nums">{formatMoney(p.amount)}</span>
                  <Badge tone={PAYOUT_STATUS[p.status].tone}>{PAYOUT_STATUS[p.status].label}</Badge>
                  <span className="font-mono text-xs text-gray-500">{p.payoutId}</span>
                  {p.depositTxnId && (
                    <Link
                      href={txnHref(companyId, 'deposit', p.depositTxnId)}
                      className="text-brand-700 hover:underline"
                    >
                      Deposit
                    </Link>
                  )}
                </div>
                {p.message && <p className="mt-1 text-gray-700">{p.message}</p>}
                <ul className="mt-2 space-y-0.5 text-xs text-gray-600">
                  {p.items.map((i, n) => (
                    <li key={n} className="flex max-w-lg justify-between gap-4">
                      <span>
                        {i.kind === 'charge'
                          ? 'Payment'
                          : i.kind === 'refund'
                            ? 'Refund'
                            : i.kind === 'dispute'
                              ? 'Chargeback'
                              : i.kind === 'dispute_reversal'
                                ? 'Chargeback reversed'
                                : (i.description ?? 'Other')}
                        {i.fee !== '0.00' && ` (fee ${formatMoney(i.fee)})`}
                      </span>
                      <span className="tabular-nums">{formatMoney(i.amount)}</span>
                    </li>
                  ))}
                </ul>
                {p.status === 'review' && canManage && (
                  <div className="mt-2 flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        run(
                          () =>
                            api(`/companies/${companyId}/online-payments/payouts/${p.id}/retry`, {
                              method: 'POST',
                            }),
                          'Tried the payout again.',
                        )
                      }
                    >
                      Try again
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        run(
                          () =>
                            api(
                              `/companies/${companyId}/online-payments/payouts/${p.id}/mark-recorded`,
                              { method: 'POST' },
                            ),
                          'Payout marked recorded.',
                        )
                      }
                    >
                      Mark recorded
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}

function StandInControls({
  payment: p,
  act,
}: {
  payment: OnlinePaymentDto;
  act: (body: object, message: string) => Promise<void>;
}) {
  const pi = p.paymentIntentId!;
  if (p.status === 'processing' && !p.failureMessage)
    return (
      <>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() =>
            act(
              { action: 'bank_result', paymentIntentId: pi, succeeded: true },
              'The bank payment cleared.',
            )
          }
        >
          Bank clears (stand-in)
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() =>
            act(
              { action: 'bank_result', paymentIntentId: pi, succeeded: false },
              'The bank payment failed.',
            )
          }
        >
          Bank fails (stand-in)
        </Button>
      </>
    );
  if (p.status !== 'succeeded') return null;
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => {
          const amount = prompt('Refund how much?', p.amount);
          if (amount) void act({ action: 'refund', paymentIntentId: pi, amount }, 'Refunded.');
        }}
      >
        Refund (stand-in)
      </Button>
      {!p.disputeStatus && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() =>
            act(
              { action: 'dispute', paymentIntentId: pi, status: 'open' },
              'The customer disputed it.',
            )
          }
        >
          Dispute (stand-in)
        </Button>
      )}
    </>
  );
}
