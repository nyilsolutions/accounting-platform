'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import QRCode from 'qrcode';
import { Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { MfaEnableDto, MfaSetupDto } from '@acct/shared';
import { AuthCard } from '@/components/auth/auth-card';
import { Alert, Button, Spinner, TextInput } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { safeNext } from '@/lib/auth-gate';
import { keys, useMe } from '@/lib/queries';

function SetupFlow() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const me = useMe();
  const started = useRef(false);
  const [setup, setSetup] = useState<MfaSetupDto | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    // Once enrollment finishes on this page, `finish()` owns the navigation.
    if (!me.isSuccess || codes) return;
    if (!me.data) return router.replace('/login');
    if (me.data.mfaEnrolled) {
      const next = params.get('next');
      return router.replace(
        me.data.mfaVerified
          ? safeNext(next)
          : `/mfa/verify${next ? `?next=${encodeURIComponent(next)}` : ''}`,
      );
    }
    if (started.current) return;
    started.current = true;
    api<MfaSetupDto>('/auth/mfa/setup', { method: 'POST' })
      .then(async (s) => {
        setSetup(s);
        setQr(await QRCode.toDataURL(s.otpauthUrl, { margin: 1, width: 192 }));
      })
      .catch((err) => setError(errorMessage(err)));
  }, [me.isSuccess, me.data, router, params, codes]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code') ?? '');
    setPending(true);
    setError(null);
    try {
      const res = await api<MfaEnableDto>('/auth/mfa/enable', { method: 'POST', body: { code } });
      setCodes(res.recoveryCodes);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  async function finish() {
    await qc.invalidateQueries({ queryKey: keys.me });
    router.push(safeNext(params.get('next')));
  }

  if (codes) {
    return (
      <div className="space-y-4">
        <Alert kind="success">Two-step verification is on.</Alert>
        <p className="text-sm text-gray-700">
          Save these recovery codes somewhere safe (a password manager is ideal). Each code works
          once if you lose your phone. They will not be shown again.
        </p>
        <ul
          className="grid grid-cols-2 gap-2 rounded-md bg-gray-50 p-3 font-mono text-sm"
          data-testid="recovery-codes"
        >
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            type="button"
            onClick={() => navigator.clipboard?.writeText(codes.join('\n'))}
          >
            Copy codes
          </Button>
          <Button type="button" onClick={finish} className="flex-1">
            I saved my codes — continue
          </Button>
        </div>
      </div>
    );
  }

  if (!setup) return error ? <Alert>{error}</Alert> : <Spinner />;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <ol className="list-decimal space-y-2 pl-5 text-sm text-gray-700">
        <li>
          Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password,
          Authy…).
        </li>
        <li>Scan this QR code, or enter the key manually.</li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      <div className="flex flex-col items-center gap-2">
        {qr && <img src={qr} alt="QR code for your authenticator app" width={192} height={192} />}
        <code
          className="break-all rounded bg-gray-50 px-2 py-1 text-center text-xs tracking-wider"
          data-testid="mfa-secret"
        >
          {setup.secret.match(/.{1,4}/g)?.join(' ')}
        </code>
      </div>
      {error && <Alert>{error}</Alert>}
      <TextInput
        label="6-digit code"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        maxLength={6}
        required
        autoFocus
      />
      <Button type="submit" className="w-full" loading={pending}>
        Turn on two-step verification
      </Button>
    </form>
  );
}

export default function MfaSetupPage() {
  return (
    <AuthCard title="Set up two-step verification" subtitle="Required for every account.">
      <Suspense>
        <SetupFlow />
      </Suspense>
    </AuthCard>
  );
}
