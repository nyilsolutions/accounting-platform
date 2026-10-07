'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MyPortalLinkDto } from '@acct/shared';
import { PortalShell } from '@/components/portal/portal-shell';
import { Card, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { RequireAuth } from '@/lib/auth-gate';

function PortalHome() {
  const router = useRouter();
  const links = useQuery({
    queryKey: ['portal', 'me'],
    queryFn: () => api<MyPortalLinkDto[]>('/portal/me'),
  });
  const only = links.data?.length === 1 ? links.data[0] : null;
  useEffect(() => {
    if (only) router.replace(`/portal/c/${only.companyId}`);
  }, [only, router]);
  if (links.isPending || only) return <Spinner />;
  const list = links.data ?? [];
  return (
    <PortalShell title="Your portals" subtitle="Where you can see your pay, time and tax forms.">
      {list.length === 0 ? (
        <Card className="p-6 text-sm text-gray-600">
          You don&apos;t have portal access yet. Ask the business for an invitation, then open the
          link in its email.
        </Card>
      ) : (
        <Card className="divide-y divide-gray-100">
          {list.map((l) => (
            <Link
              key={l.companyId}
              href={`/portal/c/${l.companyId}`}
              className="block p-4 hover:bg-gray-50"
            >
              <p className="font-medium text-gray-900">{l.companyName}</p>
              <p className="text-sm text-gray-600">
                {l.workerName} · {l.kind === 'employee' ? 'Employee' : 'Contractor'}
              </p>
            </Link>
          ))}
        </Card>
      )}
    </PortalShell>
  );
}

export default function PortalHomePage() {
  return (
    <RequireAuth>
      <PortalHome />
    </RequireAuth>
  );
}
