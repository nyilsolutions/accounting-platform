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
        description="Employees, pay schedules, states, payroll items and direct deposit."
      />
      <RouteTabs
        tabs={[
          { href: base, label: 'Employees', exact: true },
          { href: `${base}/setup`, label: 'Setup' },
          { href: `${base}/direct-deposit`, label: 'Direct deposit' },
        ]}
      />
      {children}
    </>
  );
}
