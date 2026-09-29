'use client';

import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { RouteTabs } from '@/components/ui/tabs';

export default function AccountingLayout({ children }: { children: ReactNode }) {
  const { companyId } = useParams<{ companyId: string }>();
  const base = `/c/${companyId}/accounting`;
  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold text-gray-900">Accounting</h1>
      <RouteTabs
        tabs={[
          { href: base, label: 'Chart of accounts', exact: true },
          { href: `${base}/journal-entries`, label: 'Journal entries' },
        ]}
      />
      {children}
    </>
  );
}
