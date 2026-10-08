'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { RouteTabs } from '@/components/ui/tabs';
import { buttonClass } from '@/components/ui';
import { useAccess } from '@/lib/queries';

function NewMenu({ base }: { base: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { companyId } = useParams<{ companyId: string }>();
  const access = useAccess(companyId);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) =>
      ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  if (!access.can('sales.manage') && !access.can('banking.manage')) return null;
  const items: Array<[string, string, boolean]> = [
    ['Invoice', `${base}/invoices/new`, access.can('sales.manage')],
    ['Receive payment', `${base}/payments/new`, access.can('sales.manage')],
    ['Estimate', `${base}/estimates/new`, access.can('sales.manage')],
    ['Sales receipt', `${base}/sales-receipts/new`, access.can('sales.manage')],
    ['Credit memo', `${base}/credit-memos/new`, access.can('sales.manage')],
    ['Refund receipt', `${base}/refund-receipts/new`, access.can('sales.manage')],
    ['Bank deposit', `${base}/deposits/new`, access.can('banking.manage')],
  ];
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={buttonClass()}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        New transaction ▾
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-52 rounded-md border border-gray-200 bg-white py-1 shadow-lg"
        >
          {items
            .filter(([, , ok]) => ok)
            .map(([label, href]) => (
              <Link
                key={href}
                role="menuitem"
                href={href}
                onClick={() => setOpen(false)}
                className="block px-4 py-2 text-sm text-gray-800 hover:bg-gray-50"
              >
                {label}
              </Link>
            ))}
        </div>
      )}
    </div>
  );
}

export default function SalesLayout({ children }: { children: ReactNode }) {
  const { companyId } = useParams<{ companyId: string }>();
  const base = `/c/${companyId}/sales`;
  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-4 print:hidden">
        <h1 className="text-2xl font-semibold text-gray-900">Sales</h1>
        <NewMenu base={base} />
      </div>
      <div className="print:hidden">
        <RouteTabs
          tabs={[
            { href: base, label: 'All sales', exact: true },
            { href: `${base}/estimates`, label: 'Estimates' },
            { href: `${base}/customers`, label: 'Customers' },
            { href: `${base}/products`, label: 'Products and services' },
          ]}
        />
      </div>
      {children}
    </>
  );
}
