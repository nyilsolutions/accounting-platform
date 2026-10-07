'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MfaEnableDto, SessionDto } from '@acct/shared';
import { UserMenu } from '@/components/shell/user-menu';
import { Alert, Button, Card, PageHeader, PasswordInput, Spinner } from '@/components/ui';
import { ApiError, api, errorMessage } from '@/lib/api';
import { RequireAuth } from '@/lib/auth-gate';
import { APP_NAME } from '@/lib/config';
import { keys, useMe } from '@/lib/queries';

/** Settings > Security: password, sessions and recovery codes (ADR 0029). */
function ChangePassword() {
  const me = useMe();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    setPending(true);
    setErrors({});
    setMessage(null);
    setFailure(null);
    try {
      await api('/auth/password', {
        method: 'POST',
        body: {
          currentPassword: form.get('currentPassword'),
          newPassword: form.get('newPassword'),
        },
      });
      formEl.reset();
      setMessage('Password changed. Your other sessions were signed out.');
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) {
        setErrors(Object.fromEntries(err.errors.map((x) => [x.path, x.message])));
      } else setFailure(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="space-y-4 p-6">
      <h2 className="text-base font-semibold">Password</h2>
      {message && <Alert kind="success">{message}</Alert>}
      {failure && <Alert>{failure}</Alert>}
      <form onSubmit={onSubmit} className="max-w-md space-y-4" data-testid="change-password">
        <PasswordInput
          label="Current password"
          name="currentPassword"
          autoComplete="current-password"
          required
          error={errors.currentPassword}
        />
        <PasswordInput
          label="New password"
          name="newPassword"
          autoComplete="new-password"
          required
          minLength={12}
          hint="At least 12 characters. A few unrelated words make a strong one."
          error={errors.newPassword}
          strengthFor={[me.data?.user.email ?? '', me.data?.user.fullName ?? '']}
        />
        <Button type="submit" loading={pending}>
          Change password
        </Button>
      </form>
    </Card>
  );
}

function describeAgent(ua: string | null): string {
  if (!ua) return 'Unknown browser';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : ua.slice(0, 40);
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X/.test(ua)
      ? 'macOS'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
}

function Sessions() {
  const qc = useQueryClient();
  const sessions = useQuery({
    queryKey: keys.sessions,
    queryFn: () => api<SessionDto[]>('/auth/sessions'),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: keys.sessions });
  const end = useMutation({
    mutationFn: (id: string) => api(`/auth/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  const others = useMutation({
    mutationFn: () => api('/auth/sessions/sign-out-others', { method: 'POST' }),
    onSuccess: refresh,
  });

  return (
    <Card className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Where you're signed in</h2>
        <Button
          variant="secondary"
          onClick={() => others.mutate()}
          loading={others.isPending}
          disabled={(sessions.data?.length ?? 0) < 2}
        >
          Sign out everywhere else
        </Button>
      </div>
      {sessions.isPending ? (
        <Spinner />
      ) : (
        <ul className="divide-y divide-gray-100 text-sm" data-testid="sessions">
          {(sessions.data ?? []).map((s) => (
            <li key={s.id} className="flex items-center justify-between py-2">
              <div>
                <div className="font-medium">
                  {describeAgent(s.userAgent)}
                  {s.current && <span className="ml-2 text-xs text-green-700">This browser</span>}
                </div>
                <div className="text-xs text-gray-500">
                  {s.ip ?? 'Unknown address'} · signed in {new Date(s.createdAt).toLocaleString()} ·
                  last active {new Date(s.lastSeenAt).toLocaleString()}
                </div>
              </div>
              {!s.current && (
                <Button
                  variant="secondary"
                  onClick={() => end.mutate(s.id)}
                  loading={end.isPending && end.variables === s.id}
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RecoveryCodes() {
  const [codes, setCodes] = useState<string[] | null>(null);
  const make = useMutation({
    mutationFn: () => api<MfaEnableDto>('/auth/mfa/recovery-codes', { method: 'POST' }),
    onSuccess: (r) => setCodes(r.recoveryCodes),
  });
  return (
    <Card className="space-y-4 p-6">
      <h2 className="text-base font-semibold">Recovery codes</h2>
      <p className="text-sm text-gray-600">
        Each code signs you in once if you lose your authenticator. Making new ones stops the old
        ones working.
      </p>
      {make.error && <Alert>{errorMessage(make.error)}</Alert>}
      {codes ? (
        <>
          <Alert kind="info">Save these now: they won't be shown again.</Alert>
          <ul className="grid grid-cols-2 gap-2 font-mono text-sm" data-testid="recovery-codes">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </>
      ) : (
        <Button variant="secondary" onClick={() => make.mutate()} loading={make.isPending}>
          Make new recovery codes
        </Button>
      )}
    </Card>
  );
}

export default function SecurityPage() {
  return (
    <RequireAuth>
      <div className="min-h-full">
        <header className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-3">
          <Link href="/companies" className="font-semibold text-brand-700">
            {APP_NAME}
          </Link>
          <UserMenu />
        </header>
        <main className="mx-auto max-w-3xl space-y-6 px-6 py-8">
          <PageHeader
            title="Security"
            description="Your password, the browsers you're signed in on, and recovery codes."
          />
          <ChangePassword />
          <Sessions />
          <RecoveryCodes />
        </main>
      </div>
    </RequireAuth>
  );
}
