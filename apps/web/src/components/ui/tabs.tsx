'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from './index';

/** Route-based tabs under a page header (e.g. Chart of accounts | Journal entries). */
export function RouteTabs({
  tabs,
}: {
  tabs: Array<{ href: string; label: string; exact?: boolean }>;
}) {
  const pathname = usePathname();
  return (
    <nav className="mb-5 flex gap-1 border-b border-gray-200" aria-label="Section">
      {tabs.map((t) => {
        const active = t.exact
          ? pathname === t.href
          : pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={cx(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
              active
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-gray-600 hover:text-gray-900',
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
