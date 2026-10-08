'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLE_LABELS, type InvitationPreviewDto } from '@acct/shared';
import { AuthCard } from '@/components/auth/auth-card';
import { Alert, Button, buttonClass, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { authRedirect } from '@/lib/auth-gate';
import { keys, useMe } from '@/lib/queries';

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMe();
  const invite = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api<InvitationPreviewDto>(`/invitations/${token}`),
    retry: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const here = `/invite/${token}`;

  async function accept() {
    setPending(true);
    setError(null);
    try {
      const res = await api<{ companyId: string }>(`/invitations/${token}/accept`, {
        method: 'POST',
      });
      await qc.invalidateQueries({ queryKey: keys.companies });
      router.push(`/c/${res.companyId}`);
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  }

  if (invite.isPending || me.isPending)
    return (
      <AuthCard title="Invitation">
        <Spinner />
      </AuthCard>
    );
  if (invite.isError) {
    return (
      <AuthCard title="Invitation not found">
        <p className="text-sm text-gray-700">
          This invitation link is invalid, was revoked, or has already been used.
        </p>
      </AuthCard>
    );
  }

  const inv = invite.data;
  const gate = authRedirect(me.data);
  return (
    <AuthCard
      title={`Join ${inv.companyName}`}
      subtitle={`You've been invited as ${ROLE_LABELS[inv.role]}.`}
    >
      <div className="space-y-4">
        {inv.expired && <Alert>This invitation has expired. Ask for a new one.</Alert>}
        {error && <Alert>{error}</Alert>}
        <p className="text-sm text-gray-700">
          Invitation for <strong>{inv.email}</strong>.
        </p>
        {gate === '/login' ? (
          <div className="flex gap-2">
            <Link
              href={`/register?next=${encodeURIComponent(here)}`}
              className={buttonClass('primary', 'md', 'flex-1')}
            >
              Create account
            </Link>
            <Link
              href={`/login?next=${encodeURIComponent(here)}`}
              className={buttonClass('secondary', 'md', 'flex-1')}
            >
              Sign in
            </Link>
          </div>
        ) : gate ? (
          <Link
            href={`${gate}?next=${encodeURIComponent(here)}`}
            className={buttonClass('primary', 'md', 'w-full')}
          >
            Finish signing in
          </Link>
        ) : (
          <Button className="w-full" onClick={accept} loading={pending} disabled={inv.expired}>
            Accept invitation
          </Button>
        )}
      </div>
    </AuthCard>
  );
}
