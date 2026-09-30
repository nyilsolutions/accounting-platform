'use client';

import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/ui';
import { RouteTabs } from '@/components/ui/tabs';

export default function PayrollLayout({ children }: { children: ReactNode }) {
  const { companyId } = useParams<{ companyId: string }>();
  const base = `/c/${companyId}/payroll`;
  return (
    <>
      <PageHeader
        title="Payroll"
        description="Pay runs, employees, taxes owed, payroll reports and setup."
      />
      <RouteTabs
        tabs={[
          { href: base, label: 'Employees', exact: true },
          { href: `${base}/runs`, label: 'Pay runs' },
          { href: `${base}/liabilities`, label: 'Taxes & liabilities' },
          { href: `${base}/reports`, label: 'Reports' },
          { href: `${base}/setup`, label: 'Setup' },
          { href: `${base}/direct-deposit`, label: 'Direct deposit' },
        ]}
      />
      {children}
    </>
  );
}
