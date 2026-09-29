'use client';

import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { Alert } from '@/components/ui';
import { RouteTabs } from '@/components/ui/tabs';

export default function SalesLayout({ children }: { children: ReactNode }) {
  const { companyId } = useParams<{ companyId: string }>();
  const base = `/c/${companyId}/sales`;
  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold text-gray-900">Sales</h1>
      <RouteTabs
        tabs={[
          { href: base, label: 'Customers', exact: true },
          { href: `${base}/products`, label: 'Products and services' },
        ]}
      />
      {children}
      <div className="mt-6 max-w-2xl">
        <Alert kind="info">
          Invoices, estimates, sales receipts and customer payments arrive in Phase 2.
        </Alert>
      </div>
    </>
  );
}
