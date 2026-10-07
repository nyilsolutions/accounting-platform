'use client';

import { useEffect, useState } from 'react';
import { formatMoney, type OnlinePaymentMethod } from '@acct/shared';
import { Alert, Button } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

/** Customers see dollars with the sign. */
const usd = (v: string) => `$${formatMoney(v)}`;
/** Only ever go back to this app (the stand-in's URLs come from the API, but be strict). */
function sameOrigin(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url, window.location.origin);
    return u.origin === window.location.origin ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The stand-in's checkout page (until the platform's Stripe keys exist, ADR 0022). It plays the
 * part of Stripe Checkout: nothing is charged, and its buttons send what Stripe's webhooks
 * would.
 */
export default function StandInCheckoutPage() {
  const [q, setQ] = useState<URLSearchParams | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => setQ(new URLSearchParams(window.location.search)), []);
  if (!q) return null;
  const session = q.get('session') ?? '';
  const methods = (q.get('methods') ?? '').split(',').filter(Boolean) as OnlinePaymentMethod[];

  async function act(body: object, next: string | null) {
    setError(null);
    setPending(true);
    try {
      await api('/webhooks/payments/mock', { method: 'POST', body });
      const to = sameOrigin(next);
      if (to) window.location.assign(to);
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-full items-start justify-center bg-indigo-50 px-4 py-10">
      <div className="w-full max-w-md rounded-lg border border-indigo-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
          Stripe stand-in · test mode
        </p>
        <h1 className="mt-2 text-xl font-semibold text-gray-900">{q.get('description')}</h1>
        <p className="mt-3 text-3xl font-semibold tabular-nums" data-testid="stand-in-amount">
          {usd(q.get('amount') ?? '0')}
        </p>
        <p className="mt-3 text-sm text-gray-600">
          This page stands in for Stripe Checkout until Stripe is set up. Nothing is charged.
        </p>
        {error && (
          <div className="mt-4">
            <Alert>{error}</Alert>
          </div>
        )}
        <div className="mt-5 space-y-2">
          {methods.includes('card') && (
            <Button
              type="button"
              className="w-full justify-center"
              disabled={pending}
              onClick={() =>
                act({ action: 'pay', sessionId: session, method: 'card' }, q.get('success'))
              }
            >
              Pay with test card 4242
            </Button>
          )}
          {methods.includes('us_bank_account') && (
            <Button
              type="button"
              variant="secondary"
              className="w-full justify-center"
              disabled={pending}
              onClick={() =>
                act(
                  { action: 'pay', sessionId: session, method: 'us_bank_account' },
                  q.get('success'),
                )
              }
            >
              Pay with test bank account
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            className="w-full justify-center"
            disabled={pending}
            onClick={() => act({ action: 'cancel', sessionId: session }, q.get('cancel'))}
          >
            Cancel
          </Button>
        </div>
      </div>
    </main>
  );
}
