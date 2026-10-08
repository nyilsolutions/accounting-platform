'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AuthCard } from '@/components/auth/auth-card';
import { Alert, Button, TextInput } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { safeNext } from '@/lib/auth-gate';
import { keys, useMe } from '@/lib/queries';

function VerifyForm() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const me = useMe();
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!me.isSuccess) return;
    if (!me.data) router.replace('/login');
    else if (!me.data.mfaEnrolled) router.replace('/mfa/setup');
    else if (me.data.mfaVerified) router.replace(safeNext(params.get('next')));
  }, [me.isSuccess, me.data, router, params]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code') ?? '');
    setPending(true);
    setError(null);
    try {
      await api('/auth/mfa/verify', { method: 'POST', body: { code } });
      await qc.invalidateQueries({ queryKey: keys.me });
      router.push(safeNext(params.get('next')));
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  }

  async function signOut() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    qc.setQueryData(keys.me, null);
    router.replace('/login');
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error && <Alert>{error}</Alert>}
      {useRecovery ? (
        <TextInput
          key="recovery"
          label="Recovery code"
          name="code"
          autoComplete="off"
          placeholder="XXXX-XXXX-XX"
          required
          autoFocus
        />
      ) : (
        <TextInput
          key="totp"
          label="6-digit code from your authenticator app"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          autoFocus
        />
      )}
      <Button type="submit" className="w-full" loading={pending}>
        Verify
      </Button>
      <div className="flex justify-between text-sm">
        <button
          type="button"
          className="text-brand-700 hover:underline"
          onClick={() => setUseRecovery((v) => !v)}
        >
          {useRecovery ? 'Use authenticator code' : 'Use a recovery code'}
        </button>
        <button type="button" className="text-gray-600 hover:underline" onClick={signOut}>
          Sign out
        </button>
      </div>
    </form>
  );
}

export default function MfaVerifyPage() {
  return (
    <AuthCard title="Two-step verification" subtitle="Confirm it's you.">
      <Suspense>
        <VerifyForm />
      </Suspense>
    </AuthCard>
  );
}
