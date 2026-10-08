'use client';

import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { RouteTabs } from '@/components/ui/tabs';

export default function DocumentsLayout({ children }: { children: ReactNode }) {
  const { companyId } = useParams<{ companyId: string }>();
  const base = `/c/${companyId}/documents`;
  return (
    <>
      <div className="mb-4 print:hidden">
        <h1 className="text-2xl font-semibold text-gray-900">Documents</h1>
      </div>
      <div className="print:hidden">
        <RouteTabs
          tabs={[
            { href: base, label: 'All documents', exact: true },
            { href: `${base}/inbox`, label: 'Receipts inbox' },
          ]}
        />
      </div>
      {children}
    </>
  );
}
