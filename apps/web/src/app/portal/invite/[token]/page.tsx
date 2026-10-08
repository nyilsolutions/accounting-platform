'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PortalInvitePreviewDto } from '@acct/shared';
import { AuthCard } from '@/components/auth/auth-card';
import { Alert, Button, buttonClass, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { authRedirect } from '@/lib/auth-gate';
import { useMe } from '@/lib/queries';

/** An employee's or contractor's invitation to a company's portal (ADR 0023). */
export default function PortalInvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMe();
  const invite = useQuery({
    queryKey: ['portal-invitation', token],
    queryFn: () => api<PortalInvitePreviewDto>(`/portal/invitations/${token}`),
    retry: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const here = `/portal/invite/${token}`;

  async function accept() {
    setPending(true);
    setError(null);
    try {
      const r = await api<{ companyId: string }>(`/portal/invitations/${token}/accept`, {
        method: 'POST',
      });
      await qc.invalidateQueries({ queryKey: ['portal'] });
      router.push(`/portal/c/${r.companyId}`);
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  }

  if (invite.isPending || me.isPending)
    return (
      <AuthCard title="Portal invitation">
        <Spinner />
      </AuthCard>
    );
  if (invite.isError)
    return (
      <AuthCard title="Invitation not found">
        <p className="text-sm text-gray-700">
          This invitation link is not valid, was replaced by a newer one, or was already used.
        </p>
      </AuthCard>
    );
  const inv = invite.data;
  const gate = authRedirect(me.data);
  const what =
    inv.kind === 'employee'
      ? 'see your pay stubs and W-2s, enter your time, and ask for W-4 or direct deposit changes'
      : 'enter your time and see the payments made to you and your 1099 totals';
  return (
    <AuthCard title={`${inv.companyName} portal`} subtitle={`For ${inv.workerName}`}>
      <div className="space-y-4 text-sm text-gray-700">
        <p>
          {inv.companyName} invited you to its portal, where you can {what}. It doesn&apos;t give
          you access to the company&apos;s books.
        </p>
        {inv.expired ? (
          <Alert>This invitation has expired. Ask {inv.companyName} for a new one.</Alert>
        ) : gate ? (
          <>
            <p>
              Sign in, or create your account, with <strong>{inv.email}</strong>. You&apos;ll set up
              an authenticator app to protect your pay information.
            </p>
            <div className="flex gap-2">
              <Link href={`/register?next=${encodeURIComponent(here)}`} className={buttonClass()}>
                Create account
              </Link>
              <Link
                href={`/login?next=${encodeURIComponent(here)}`}
                className={buttonClass('secondary')}
              >
                Sign in
              </Link>
            </div>
          </>
        ) : (
          <>
            {error && <Alert>{error}</Alert>}
            <Button onClick={accept} loading={pending} className="w-full justify-center">
              Accept and open the portal
            </Button>
          </>
        )}
      </div>
    </AuthCard>
  );
}
