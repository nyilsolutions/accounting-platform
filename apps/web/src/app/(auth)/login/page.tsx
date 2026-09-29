'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { MeDto } from '@acct/shared';
import { AuthCard } from '@/components/auth/auth-card';
import { Alert, Button, TextInput } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { authRedirect, safeNext } from '@/lib/auth-gate';
import { keys } from '@/lib/queries';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      const me = await api<MeDto>('/auth/login', {
        method: 'POST',
        body: { email: form.get('email'), password: form.get('password') },
      });
      qc.setQueryData(keys.me, me);
      const next = params.get('next');
      const target = authRedirect(me);
      router.push(
        target ? `${target}${next ? `?next=${encodeURIComponent(next)}` : ''}` : safeNext(next),
      );
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <TextInput
        label="Email"
        name="email"
        type="email"
        autoComplete="username"
        required
        autoFocus
      />
      <TextInput
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />
      <Button type="submit" className="w-full" loading={pending}>
        Sign in
      </Button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <AuthCard
      title="Sign in"
      subtitle={
        <>
          New here?{' '}
          <Link href="/register" className="font-medium text-brand-700 hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthCard>
  );
}
