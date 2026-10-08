'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import type { MeDto } from '@acct/shared';
import { Spinner } from '@/components/ui';
import { useMe } from './queries';

/** Where a user in this state belongs, or null when they may see protected pages. */
export function authRedirect(me: MeDto | null | undefined): string | null {
  if (!me) return '/login';
  if (!me.mfaEnrolled) return '/mfa/setup';
  if (!me.mfaVerified) return '/mfa/verify';
  return null;
}

/** Renders children only for a signed-in user who has completed MFA. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const router = useRouter();
  const me = useMe();
  const target = me.isSuccess ? authRedirect(me.data) : null;

  useEffect(() => {
    if (target) {
      const next =
        target === '/login'
          ? `?next=${encodeURIComponent(location.pathname + location.search)}`
          : '';
      router.replace(target + next);
    }
  }, [target, router]);

  if (me.isError) return <Spinner label="Unable to reach the server. Retrying…" />;
  if (!me.isSuccess || target) return <Spinner />;
  return <>{children}</>;
}

/** Only allows internal paths as post-login redirects (prevents open redirects). */
export function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/companies';
}
