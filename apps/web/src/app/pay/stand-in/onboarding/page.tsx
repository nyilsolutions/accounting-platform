'use client';

import { useEffect, useState } from 'react';
import { Alert, Button } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

/**
 * The stand-in's account onboarding (where Stripe would ask for the business's details and bank
 * account). Finishing it makes the stand-in account able to take payments.
 */
export default function StandInOnboardingPage() {
  const [q, setQ] = useState<URLSearchParams | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => setQ(new URLSearchParams(window.location.search)), []);
  if (!q) return null;

  async function finish() {
    setError(null);
    setPending(true);
    try {
      await api('/webhooks/payments/mock', {
        method: 'POST',
        body: { action: 'finish_onboarding', accountId: q!.get('account') },
      });
      const back = new URL(q!.get('return') ?? '/', window.location.origin);
      window.location.assign(back.origin === window.location.origin ? back.toString() : '/');
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
        <h1 className="mt-2 text-xl font-semibold text-gray-900">Set up your payments account</h1>
        <p className="mt-3 text-sm text-gray-600">
          With Stripe, this is where you would enter your business details, verify your identity and
          add the bank account for payouts. The stand-in needs nothing.
        </p>
        <p className="mt-2 font-mono text-xs text-gray-500">{q.get('account')}</p>
        {error && (
          <div className="mt-4">
            <Alert>{error}</Alert>
          </div>
        )}
        <Button
          type="button"
          className="mt-5 w-full justify-center"
          disabled={pending}
          onClick={finish}
        >
          Finish setup
        </Button>
      </div>
    </main>
  );
}
