'use client';

import { useEffect, useState } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { Alert, Button, TextInput } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

/** Customers ask for a sign-in link by email (no password). */
export default function CustomerSignInPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    setExpired(q.has('expired'));
    // An invitation opens this page with the customer's address filled in.
    setEmail(q.get('email') ?? '');
  }, []);

  return (
    <AuthCard
      title="Your invoices"
      subtitle="See your invoices, statement and estimates, and pay online"
    >
      {sent ? (
        <div className="space-y-2 text-sm text-gray-700" role="status">
          <p className="font-medium text-gray-900">Check your email</p>
          <p>
            If {email} is on file with a business here, we sent a link to sign in. It works once and
            expires in 10 minutes.
          </p>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            setBusy(true);
            try {
              await api('/portal/customer/sign-in', { method: 'POST', body: { email } });
              setSent(true);
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {expired && <Alert kind="info">Your session ended. Ask for a new link.</Alert>}
          {error && <Alert>{error}</Alert>}
          <TextInput
            label="Your email address"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button type="submit" loading={busy} className="w-full justify-center">
            Email me a sign-in link
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
