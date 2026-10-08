'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PortalLinkDto } from '@acct/shared';
import { Alert, Badge, Button, Card, TextInput } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

const STATUS: Record<PortalLinkDto['status'], { label: string; tone: 'green' | 'amber' | 'gray' }> =
  {
    active: { label: 'Has portal access', tone: 'green' },
    invited: { label: 'Invited', tone: 'amber' },
    expired: { label: 'Invitation expired', tone: 'gray' },
    revoked: { label: 'Access removed', tone: 'gray' },
  };

/**
 * Portal access for one employee or contractor (ADR 0023): invite them by email, see whether
 * they accepted, remove access. The portal shows only their own records.
 */
export function PortalAccessCard({
  companyId,
  kind,
  workerId,
  defaultEmail,
  canManage,
}: {
  companyId: string;
  kind: 'employee' | 'contractor';
  workerId: string;
  defaultEmail: string | null;
  canManage: boolean;
}) {
  const qc = useQueryClient();
  const key = ['company', companyId, 'portal-links'];
  const links = useQuery({
    queryKey: key,
    queryFn: () => api<PortalLinkDto[]>(`/companies/${companyId}/portal/links`),
  });
  const [email, setEmail] = useState(defaultEmail ?? '');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const link = (links.data ?? []).find(
    (l) =>
      l.status !== 'revoked' &&
      (kind === 'employee' ? l.employeeId === workerId : l.vendorId === workerId),
  );

  async function run(fn: () => Promise<unknown>, message: string) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await fn();
      setNotice(message);
      await qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const what =
    kind === 'employee'
      ? 'pay stubs, W-2s and their own time, and asking for W-4 or direct deposit changes'
      : 'their own time, the payments made to them and their 1099 totals';

  return (
    <Card className="mb-6 p-5" data-testid="portal-access">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-gray-900">Portal access</h2>
        {link && <Badge tone={STATUS[link.status].tone}>{STATUS[link.status].label}</Badge>}
      </div>
      <p className="mb-3 text-sm text-gray-600">
        A sign-in of their own for {what}. It never opens the company&apos;s books.
      </p>
      {error && (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      )}
      {notice && (
        <div className="mb-3">
          <Alert kind="success">{notice}</Alert>
        </div>
      )}
      {link?.status === 'active' ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-gray-700">
            {link.userName} ({link.email}) since {new Date(link.acceptedAt!).toLocaleDateString()}
          </span>
          {canManage && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() =>
                confirm('Remove their portal access?') &&
                run(
                  () =>
                    api(`/companies/${companyId}/portal/links/${link.id}`, { method: 'DELETE' }),
                  'Portal access removed.',
                )
              }
            >
              Remove access
            </Button>
          )}
        </div>
      ) : (
        canManage && (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                () =>
                  api(`/companies/${companyId}/portal/invitations`, {
                    method: 'POST',
                    body: {
                      kind,
                      ...(kind === 'employee' ? { employeeId: workerId } : { vendorId: workerId }),
                      email,
                    },
                  }),
                `Invitation sent to ${email}.`,
              );
            }}
          >
            <div className="w-72">
              <TextInput
                label="Their email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <Button type="submit" loading={busy}>
              {link ? 'Send a new invitation' : 'Invite to the portal'}
            </Button>
          </form>
        )
      )}
    </Card>
  );
}
