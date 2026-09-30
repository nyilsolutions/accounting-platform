'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { buttonClass } from '@/components/ui';

export default function InventoryLayout({ children }: { children: ReactNode }) {
  const { companyId } = useParams<{ companyId: string }>();
  const base = `/c/${companyId}/inventory`;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4 print:hidden">
        <h1 className="text-2xl font-semibold text-gray-900">
          <Link href={base}>Inventory</Link>
        </h1>
        <div className="flex gap-2">
          <Link href={`${base}/adjustments/new`} className={buttonClass('secondary')}>
            Adjust quantity
          </Link>
          <Link href={`${base}/builds/new`} className={buttonClass('secondary')}>
            Build assembly
          </Link>
          <Link href={`${base}/start`} className={buttonClass('secondary')}>
            Start tracking items
          </Link>
        </div>
      </div>
      {children}
    </>
  );
}
