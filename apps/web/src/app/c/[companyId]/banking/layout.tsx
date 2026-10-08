'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { RouteTabs } from '@/components/ui/tabs';
import { buttonClass } from '@/components/ui';
import { useAccess } from '@/lib/queries';

function NewMenu({ companyId }: { companyId: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const access = useAccess(companyId);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) =>
      ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  if (!access.can('banking.manage')) return null;
  const c = `/c/${companyId}`;
  const items: Array<[string, string]> = [
    ['Transfer', `${c}/banking/transfers/new`],
    ['Pay down credit card', `${c}/banking/transfers/new?card=1`],
    ['Bank deposit', `${c}/sales/deposits/new`],
    ['Expense', `${c}/expenses/expenses/new`],
    ['Check', `${c}/expenses/checks/new`],
    ['Upload transactions', `${c}/banking/import`],
    ['Reconcile', `${c}/banking/reconcile`],
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
        New ▾
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-52 rounded-md border border-gray-200 bg-white py-1 shadow-lg"
        >
          {items.map(([label, href]) => (
            <Link
              key={label}
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

export default function BankingLayout({ children }: { children: ReactNode }) {
  const { companyId } = useParams<{ companyId: string }>();
  const base = `/c/${companyId}/banking`;
  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-4 print:hidden">
        <h1 className="text-2xl font-semibold text-gray-900">Banking</h1>
        <NewMenu companyId={companyId} />
      </div>
      <div className="print:hidden">
        <RouteTabs
          tabs={[
            { href: base, label: 'Bank transactions', exact: true },
            { href: `${base}/reconcile`, label: 'Reconcile' },
            { href: `${base}/rules`, label: 'Rules' },
          ]}
        />
      </div>
      {children}
    </>
  );
}
