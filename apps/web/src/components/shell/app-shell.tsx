'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import { ROLE_LABELS } from '@acct/shared';
import { Dialog, Spinner, cx } from '@/components/ui';
import { APP_NAME } from '@/lib/config';
import { useAccess, useCompanies } from '@/lib/queries';
import { CommandPalette, type Command } from './command-palette';
import { NAV, type NavItem } from './nav';
import { useShortcuts } from './use-shortcuts';
import { UserMenu } from './user-menu';

export function AppShell({ companyId, children }: { companyId: string; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const access = useAccess(companyId);
  const companies = useCompanies();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const base = `/c/${companyId}`;
  const visible = useMemo(
    () =>
      NAV.filter(
        (n) =>
          !n.permission ||
          (Array.isArray(n.permission) ? n.permission : [n.permission]).some((p) =>
            access.data?.permissions.includes(p),
          ),
      ),
    [access.data],
  );
  const company = companies.data?.find((c) => c.id === companyId);

  useShortcuts({
    onPalette: () => setPaletteOpen(true),
    onHelp: () => setHelpOpen(true),
    onGo: (key) => {
      const item = visible.find((n) => n.shortcut === key);
      if (item) router.push(base + item.path);
    },
  });

  const commands: Command[] = useMemo(
    () => [
      ...visible.map((n) => ({
        id: `nav-${n.key}`,
        label: n.label,
        group: 'Go to',
        hint: n.shortcut ? `g ${n.shortcut}` : undefined,
        run: () => router.push(base + n.path),
      })),
      ...(companies.data ?? [])
        .filter((c) => c.id !== companyId)
        .map((c) => ({
          id: `co-${c.id}`,
          label: c.legalName,
          group: 'Switch company',
          run: () => router.push(`/c/${c.id}`),
        })),
      {
        id: 'all-companies',
        label: 'All companies',
        group: 'Switch company',
        run: () => router.push('/companies'),
      },
    ],
    [visible, companies.data, companyId, base, router],
  );

  if (access.isPending) return <Spinner />;
  if (access.isError) {
    return (
      <main className="mx-auto max-w-lg p-10 text-center">
        <h1 className="text-xl font-semibold">Company not found</h1>
        <p className="mt-2 text-sm text-gray-600">
          It may not exist, or you no longer have access to it.
        </p>
        <Link href="/companies" className="mt-4 inline-block text-brand-700 hover:underline">
          Back to your companies
        </Link>
      </main>
    );
  }

  const isActive = (n: NavItem) => {
    const href = base + n.path;
    return n.path === ''
      ? pathname === base
      : pathname === href || (n.key !== 'company' && pathname.startsWith(href + '/'));
  };

  const renderNav = (section: NavItem['section']) =>
    visible
      .filter((n) => n.section === section)
      .map((n) => (
        <Link
          key={n.key}
          href={base + n.path}
          aria-current={isActive(n) ? 'page' : undefined}
          className={cx(
            'flex items-center justify-between rounded-md px-3 py-2 text-sm',
            isActive(n)
              ? 'bg-brand-600 text-white'
              : 'text-gray-300 hover:bg-sidebar-hover hover:text-white',
          )}
        >
          {n.label}
        </Link>
      ));

  return (
    <div className="flex min-h-full">
      <aside
        className="flex w-60 shrink-0 flex-col bg-sidebar px-3 py-4 print:hidden"
        aria-label="Main navigation"
      >
        <Link href={base} className="mb-6 px-3 text-lg font-semibold text-white">
          {APP_NAME}
        </Link>
        <nav className="flex-1 space-y-1">{renderNav('main')}</nav>
        <div className="mt-6 border-t border-white/10 pt-4">
          <p className="px-3 pb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Settings
          </p>
          <nav className="space-y-1">{renderNav('settings')}</nav>
        </div>
        <button
          onClick={() => setHelpOpen(true)}
          className="mt-4 px-3 text-left text-xs text-gray-400 hover:text-gray-200"
        >
          Keyboard shortcuts <kbd className="!bg-transparent !text-gray-300">?</kbd>
        </button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-gray-200 bg-white px-6 py-3 print:hidden">
          <div className="flex items-center gap-3">
            <label htmlFor="company-switcher" className="sr-only">
              Company
            </label>
            <select
              id="company-switcher"
              data-testid="company-switcher"
              value={companyId}
              onChange={(e) =>
                router.push(e.target.value === '__all' ? '/companies' : `/c/${e.target.value}`)
              }
              className="max-w-xs rounded-md border border-gray-300 bg-white py-1.5 pl-3 pr-8 text-sm font-medium"
            >
              {(companies.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.legalName}
                </option>
              ))}
              <option value="__all">All companies…</option>
            </select>
            {company && <span className="text-xs text-gray-500">{ROLE_LABELS[company.role]}</span>}
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={() => setPaletteOpen(true)}
              className="hidden items-center gap-2 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-50 sm:flex"
            >
              Search <kbd>Ctrl K</kbd>
            </button>
            <UserMenu />
          </div>
        </header>
        <main className="flex-1 px-6 py-6 lg:px-10 print:p-0">{children}</main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
      <Dialog open={helpOpen} onClose={() => setHelpOpen(false)} title="Keyboard shortcuts">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-gray-100">
            <tr>
              <td className="py-1.5">
                <kbd>Ctrl</kbd> + <kbd>K</kbd>
              </td>
              <td>Search / go to / switch company</td>
            </tr>
            <tr>
              <td className="py-1.5">
                <kbd>?</kbd>
              </td>
              <td>Show this help</td>
            </tr>
            {visible
              .filter((n) => n.shortcut)
              .map((n) => (
                <tr key={n.key}>
                  <td className="py-1.5">
                    <kbd>g</kbd> then <kbd>{n.shortcut}</kbd>
                  </td>
                  <td>{n.label}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </Dialog>
    </div>
  );
}
