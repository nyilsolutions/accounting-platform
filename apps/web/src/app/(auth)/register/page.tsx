'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PASSWORD_MIN_LENGTH, type MeDto } from '@acct/shared';
import { AuthCard } from '@/components/auth/auth-card';
import { Alert, Button, PasswordInput, TextInput } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { keys } from '@/lib/queries';

function RegisterForm() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [error, setError] = useState<ApiError | string | null>(null);
  const [pending, setPending] = useState(false);
  // The name and email, so the strength meter can count them against the password.
  const [who, setWho] = useState<string[]>([]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    if (form.get('password') !== form.get('confirm')) {
      setError('Passwords do not match');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const me = await api<MeDto>('/auth/register', {
        method: 'POST',
        body: {
          fullName: form.get('fullName'),
          email: form.get('email'),
          password: form.get('password'),
        },
      });
      qc.setQueryData(keys.me, me);
      const next = params.get('next');
      router.push(`/mfa/setup${next ? `?next=${encodeURIComponent(next)}` : ''}`);
    } catch (err) {
      setError(err instanceof ApiError ? err : errorMessage(err));
      setPending(false);
    }
  }

  const fieldError = (path: string) =>
    error instanceof ApiError ? error.fieldError(path) : undefined;

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4"
      onChange={(e) => {
        const f = new FormData(e.currentTarget);
        setWho([String(f.get('fullName') ?? ''), String(f.get('email') ?? '')]);
      }}
    >
      {error && <Alert>{typeof error === 'string' ? error : error.message}</Alert>}
      <TextInput
        label="Full name"
        name="fullName"
        autoComplete="name"
        required
        autoFocus
        error={fieldError('fullName')}
      />
      <TextInput
        label="Work email"
        name="email"
        type="email"
        autoComplete="email"
        required
        error={fieldError('email')}
      />
      <PasswordInput
        label="Password"
        name="password"
        autoComplete="new-password"
        minLength={PASSWORD_MIN_LENGTH}
        required
        hint={`At least ${PASSWORD_MIN_LENGTH} characters. A passphrase is easiest to remember.`}
        error={fieldError('password')}
        strengthFor={who}
      />
      <PasswordInput label="Confirm password" name="confirm" autoComplete="new-password" required />
      <Button type="submit" className="w-full" loading={pending}>
        Create account
      </Button>
      <p className="text-xs text-gray-500">
        Next, you will set up two-step verification with an authenticator app. It is required
        because your account will hold financial and payroll data.
      </p>
    </form>
  );
}

export default function RegisterPage() {
  return (
    <AuthCard
      title="Create your account"
      subtitle={
        <>
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-brand-700 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <Suspense>
        <RegisterForm />
      </Suspense>
    </AuthCard>
  );
}
