'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { OnlinePaymentsSettingsDto, PaymentAccountUpdate } from '@acct/shared';
import { AccountSelect } from '@/components/ledger/pickers';
import { Alert, Badge, Button, Card } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, useAccounts, useLedgerSettings, useOnlinePayments } from '@/lib/queries';

const STATUS: Record<string, { label: string; tone: 'green' | 'amber' | 'gray' }> = {
  active: { label: 'Taking payments', tone: 'green' },
  pending: { label: 'Setup not finished', tone: 'amber' },
  restricted: { label: 'Paused by Stripe', tone: 'amber' },
  disconnected: { label: 'Disconnected', tone: 'gray' },
};

/**
 * Company settings › Online payments (ADR 0022): connect the company's own Stripe account,
 * choose what customers can pay with and where payouts, fees, refunds and chargebacks go.
 */
export function OnlinePaymentsCard({
  companyId,
  canEdit,
}: {
  companyId: string;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const settings = useOnlinePayments(companyId);
  const accounts = useAccounts(companyId);
  const ledger = useLedgerSettings(companyId);
  const [payoutBank, setPayoutBank] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const refreshed = useRef(false);

  async function run<T>(fn: () => Promise<T>, message?: string): Promise<T | null> {
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      const r = await fn();
      if (message) setNotice(message);
      return r;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setPending(false);
    }
  }
  const store = (s: OnlinePaymentsSettingsDto) => {
    qc.setQueryData(keys.onlinePayments(companyId), s);
    void qc.invalidateQueries({ queryKey: ['company', companyId, 'accounts'] });
  };

  const account = settings.data?.account;
  // Back from Stripe's onboarding (…/settings?online-payments=1): ask Stripe how it went.
  useEffect(() => {
    const returning = new URLSearchParams(window.location.search).has('online-payments');
    if (!returning || !canEdit || refreshed.current || !account) return;
    if (account.status === 'disconnected') return;
    refreshed.current = true;
    void run(async () => {
      const s = await api<OnlinePaymentsSettingsDto>(
        `/companies/${companyId}/online-payments/refresh`,
        { method: 'POST' },
      );
      store(s);
    });
  }, [canEdit, account?.status]);

  if (!settings.data || !accounts.data) return null;
  const s = settings.data;
  const all = accounts.data.filter((a) => !a.currency);
  const useNumbers = ledger.data?.useAccountNumbers ?? false;
  const providerName = s.provider === 'mock' ? 'the Stripe stand-in' : 'Stripe';

  async function connect() {
    const r = await run(() =>
      api<{ url: string }>(`/companies/${companyId}/online-payments/connect`, {
        method: 'POST',
        body: { depositAccountId: payoutBank || account?.depositAccountId },
      }),
    );
    if (r) window.location.assign(r.url);
  }
  async function update(body: PaymentAccountUpdate, message: string) {
    const r = await run(
      () =>
        api<OnlinePaymentsSettingsDto>(`/companies/${companyId}/online-payments`, {
          method: 'PATCH',
          body,
        }),
      message,
    );
    if (r) store(r);
  }
  async function disconnect() {
    if (
      !confirm(
        'Stop taking online payments? Links already sent stop working. Your Stripe account itself stays open.',
      )
    )
      return;
    const r = await run(
      () =>
        api<OnlinePaymentsSettingsDto>(`/companies/${companyId}/online-payments`, {
          method: 'DELETE',
        }),
      'Online payments are off.',
    );
    if (r) store(r);
  }

  const live = account && account.status !== 'disconnected';
  return (
    <Card className="max-w-4xl p-6" data-testid="online-payments-settings">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">Online payments</h2>
        {live && <Badge tone={STATUS[account.status]!.tone}>{STATUS[account.status]!.label}</Badge>}
      </div>
      <p className="mb-4 text-sm text-gray-600">
        Customers pay invoices by card or bank transfer (ACH) from a link in the invoice email. The
        money goes to your own Stripe account; payments are recorded to Undeposited Funds, and each
        Stripe payout becomes a bank deposit with its fees taken out. You pay Stripe&apos;s fees.
      </p>
      {s.provider === 'mock' && (
        <div className="mb-4">
          <Alert kind="info">
            Stripe isn&apos;t set up on this server yet, so a stand-in takes test payments. Nothing
            is charged.
          </Alert>
        </div>
      )}
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}
      {notice && (
        <div className="mb-4">
          <Alert kind="success">{notice}</Alert>
        </div>
      )}
      {!s.provider ? (
        <p className="text-sm text-gray-600">Online payments are off on this server.</p>
      ) : !live ? (
        canEdit ? (
          <div className="flex flex-wrap items-end gap-3">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Payouts go to</span>
              <AccountSelect
                aria-label="Bank account for payouts"
                accounts={all}
                types={['bank']}
                useNumbers={useNumbers}
                value={payoutBank}
                onChange={(e) => setPayoutBank(e.target.value)}
              />
            </label>
            <Button type="button" onClick={connect} disabled={pending || !payoutBank}>
              Connect {s.provider === 'mock' ? 'Stripe (stand-in)' : 'Stripe'}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-gray-600">Not connected.</p>
        )
      ) : (
        <div className="space-y-4 text-sm">
          {account.status !== 'active' && (
            <Alert kind="info">
              {account.requirements ??
                `Finish setting up your account with ${providerName} to take payments.`}
              {canEdit && (
                <span className="ml-2">
                  <button
                    type="button"
                    className="font-medium text-brand-700 underline"
                    onClick={connect}
                    disabled={pending}
                  >
                    Continue setup
                  </button>
                </span>
              )}
            </Alert>
          )}
          <p className="text-gray-600">
            Stripe account <span className="font-mono">{account.accountId}</span>
            {account.connectedBy ? `, connected by ${account.connectedBy}` : ''}.
          </p>
          <fieldset className="flex flex-wrap gap-6">
            <legend className="mb-1 font-medium text-gray-700">Customers can pay by</legend>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={account.acceptCard}
                disabled={!canEdit || pending}
                onChange={(e) => update({ acceptCard: e.target.checked }, 'Ways to pay updated.')}
              />
              Card
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={account.acceptAch}
                disabled={!canEdit || pending}
                onChange={(e) => update({ acceptAch: e.target.checked }, 'Ways to pay updated.')}
              />
              Bank transfer (ACH)
            </label>
          </fieldset>
          <div className="grid gap-3 md:grid-cols-2">
            {(
              [
                ['depositAccountId', 'Payouts go to', ['bank']],
                ['feeAccountId', 'Processing fees', ['expense', 'other_expense']],
                ['refundAccountId', 'Refunds', ['income', 'other_income']],
                ['chargebackAccountId', 'Chargebacks', ['expense', 'other_expense']],
              ] as const
            ).map(([field, label, types]) => (
              <label key={field} className="block">
                <span className="mb-1 block font-medium text-gray-700">{label}</span>
                <AccountSelect
                  aria-label={label}
                  accounts={all}
                  types={[...types]}
                  useNumbers={useNumbers}
                  value={account[field]}
                  disabled={!canEdit || pending}
                  onChange={(e) =>
                    e.target.value && update({ [field]: e.target.value }, `${label}: saved.`)
                  }
                />
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href={`/c/${companyId}/sales/online-payments`}
              className="text-brand-700 hover:underline"
            >
              Online payments and payouts →
            </Link>
            {canEdit && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={disconnect}
                disabled={pending}
              >
                Disconnect
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
