'use client';

import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { RouteTabs } from '@/components/ui/tabs';
import { useAccess } from '@/lib/queries';

export default function TimeLayout({ children }: { children: ReactNode }) {
  const { companyId } = useParams<{ companyId: string }>();
  const access = useAccess(companyId);
  const base = `/c/${companyId}/time`;
  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold text-gray-900 print:hidden">Time</h1>
      <div className="print:hidden">
        <RouteTabs
          tabs={[
            ...(access.can('time.manage') ? [{ href: base, label: 'Timesheet', exact: true }] : []),
            { href: `${base}/approvals`, label: 'Approve time' },
          ]}
        />
      </div>
      {children}
    </>
  );
}
