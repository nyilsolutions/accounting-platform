'use client';

import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MyPortalLinkDto } from '@acct/shared';
import { PortalLinkContext } from '@/components/portal/portal-context';
import { PortalShell } from '@/components/portal/portal-shell';
import { Card, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { RequireAuth } from '@/lib/auth-gate';

function CompanyPortal({ children }: { children: ReactNode }) {
  const { companyId } = useParams<{ companyId: string }>();
  const links = useQuery({
    queryKey: ['portal', 'me'],
    queryFn: () => api<MyPortalLinkDto[]>('/portal/me'),
  });
  if (links.isPending) return <Spinner />;
  const link = links.data?.find((l) => l.companyId === companyId);
  if (!link)
    return (
      <PortalShell title="Portal not found">
        <Card className="p-6 text-sm text-gray-600">
          You don&apos;t have portal access to this company.
        </Card>
      </PortalShell>
    );
  const base = `/portal/c/${companyId}`;
  const tabs =
    link.kind === 'employee'
      ? [
          { href: `${base}/paychecks`, label: 'Pay stubs' },
          { href: `${base}/time`, label: 'Time' },
          { href: `${base}/tax-forms`, label: 'W-2' },
          { href: `${base}/details`, label: 'W-4 and direct deposit' },
        ]
      : [
          { href: `${base}/payments`, label: 'Payments' },
          { href: `${base}/time`, label: 'Time' },
          { href: `${base}/tax-forms`, label: '1099' },
        ];
  return (
    <PortalLinkContext.Provider value={link}>
      <PortalShell
        title={link.companyName}
        subtitle={`${link.workerName} · ${link.kind === 'employee' ? 'Employee' : 'Contractor'} portal`}
        tabs={tabs}
      >
        {children}
      </PortalShell>
    </PortalLinkContext.Provider>
  );
}

export default function CompanyPortalLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <CompanyPortal>{children}</CompanyPortal>
    </RequireAuth>
  );
}
