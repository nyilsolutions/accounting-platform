'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { UserMenu } from '@/components/shell/user-menu';
import { cx } from '@/components/ui';
import { APP_NAME } from '@/lib/config';

/**
 * The frame of the employee and contractor portal (ADR 0023): the company and the person, the
 * portal's own tabs, and the account menu. Nothing from the company's books is linked.
 */
export function PortalShell({
  title,
  subtitle,
  tabs,
  children,
}: {
  title: string;
  subtitle?: string;
  tabs?: Array<{ href: string; label: string }>;
  children: ReactNode;
}) {
  const path = usePathname();
  return (
    <div className="min-h-full bg-gray-50">
      <header className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-3 print:hidden">
        <Link href="/portal" className="font-semibold text-brand-700">
          {APP_NAME}
        </Link>
        <UserMenu />
      </header>
      <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        <div className="mb-4 print:hidden">
          <h1 className="text-2xl font-semibold text-gray-900">{title}</h1>
          {subtitle && <p className="text-sm text-gray-600">{subtitle}</p>}
        </div>
        {tabs && (
          <nav
            className="mb-6 flex flex-wrap gap-1 border-b border-gray-200 print:hidden"
            aria-label="Portal"
          >
            {tabs.map((t) => {
              const active = path === t.href || path.startsWith(`${t.href}/`);
              return (
                <Link
                  key={t.href}
                  href={t.href}
                  aria-current={active ? 'page' : undefined}
                  className={cx(
                    '-mb-px border-b-2 px-3 py-2 text-sm',
                    active
                      ? 'border-brand-600 font-medium text-brand-700'
                      : 'border-transparent text-gray-600 hover:text-gray-900',
                  )}
                >
                  {t.label}
                </Link>
              );
            })}
          </nav>
        )}
        {children}
      </main>
    </div>
  );
}
