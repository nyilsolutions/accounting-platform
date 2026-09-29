'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Badge, Card, PageHeader, Spinner } from '@/components/ui';
import { useQuery } from '@tanstack/react-query';
import { formatMoney, presetRange, todayIso, type ReportDto } from '@acct/shared';
import { api } from '@/lib/api';
import { useAccess, useAccounts, useCompany } from '@/lib/queries';

export default function DashboardPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const company = useCompany(companyId);
  const access = useAccess(companyId);
  const accounts = useAccounts(companyId);
  const fy = presetRange(
    'this_fiscal_year_to_date',
    todayIso(),
    company.data?.fiscalYearStartMonth ?? 1,
  );
  const pl = useQuery({
    queryKey: ['company', companyId, 'report', 'dashboard-pl', fy],
    queryFn: () =>
      api<ReportDto>(`/companies/${companyId}/reports/profit-and-loss?from=${fy.from}&to=${fy.to}`),
    enabled: company.isSuccess && access.can('reports.view'),
  });
  if (company.isPending) return <Spinner />;
  if (!company.data) return null;
  const c = company.data;
  const base = `/c/${companyId}`;

  const checklist = [
    {
      label: 'Complete your company profile (EIN and address)',
      done: Boolean(c.einMasked && c.addressLine1 && c.state),
      href: `${base}/settings`,
    },
    {
      label: 'Invite your accountant or team',
      done: false,
      href: `${base}/settings/users`,
      show: access.can('users.manage'),
    },
    {
      label: 'Review your chart of accounts',
      done: (accounts.data?.length ?? 0) > 0,
      href: `${base}/accounting`,
      show: access.can('ledger.view'),
    },
    { label: 'Import your QuickBooks company', done: false, soon: 'Phase 6' },
    { label: 'Connect your bank accounts', done: false, soon: 'Phase 4' },
    { label: 'Set up payroll', done: false, soon: 'Phase 8' },
  ].filter((i) => i.show !== false);

  return (
    <>
      <PageHeader
        title={c.legalName}
        description={c.dbaName ? `Doing business as ${c.dbaName}` : 'Dashboard'}
      />
      <div className="grid grid-flow-row-dense gap-6 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <h2 className="mb-3 font-semibold text-gray-900">Get set up</h2>
          <ul className="divide-y divide-gray-100">
            {checklist.map((item) => (
              <li key={item.label} className="flex items-center justify-between py-2.5 text-sm">
                <span className="flex items-center gap-3">
                  <span
                    aria-hidden
                    className={
                      item.done
                        ? 'flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-xs text-white'
                        : 'h-5 w-5 rounded-full border-2 border-gray-300'
                    }
                  >
                    {item.done ? '✓' : ''}
                  </span>
                  {item.href && !item.done ? (
                    <Link href={item.href} className="text-brand-700 hover:underline">
                      {item.label}
                    </Link>
                  ) : (
                    <span className={item.done ? 'text-gray-500 line-through' : 'text-gray-800'}>
                      {item.label}
                    </span>
                  )}
                </span>
                {item.soon && <Badge tone="amber">Coming in {item.soon}</Badge>}
              </li>
            ))}
          </ul>
        </Card>
        {pl.data && (
          <Card className="p-5 lg:col-span-2">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="font-semibold text-gray-900">Profit and loss</h2>
              <span className="text-xs text-gray-500">This fiscal year to date</span>
            </div>
            <dl className="grid grid-cols-3 gap-4 text-sm" data-testid="dashboard-pl">
              {[
                ['Income', 'Total Income'],
                ['Expenses', 'Total Expenses'],
                ['Net income', 'Net Income'],
              ].map(([label, row]) => {
                const v = pl.data.rows.find((r) => r.label === row)?.amounts[0] ?? '0';
                return (
                  <div key={label}>
                    <dt className="text-gray-500">{label}</dt>
                    <dd className="text-xl font-semibold tabular-nums">${formatMoney(v)}</dd>
                  </div>
                );
              })}
            </dl>
            <Link
              href={`${base}/reports/profit-and-loss`}
              className="mt-3 inline-block text-sm text-brand-700 hover:underline"
            >
              View report
            </Link>
          </Card>
        )}
        <Card className="p-5">
          <h2 className="mb-3 font-semibold text-gray-900">Company</h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">EIN</dt>
              <dd className="font-mono">{c.einMasked ?? '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Fiscal year starts</dt>
              <dd>
                {new Date(2000, c.fiscalYearStartMonth - 1, 1).toLocaleString('en-US', {
                  month: 'long',
                })}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Accounting method</dt>
              <dd className="capitalize">{c.accountingBasis}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Location</dt>
              <dd>{[c.city, c.state].filter(Boolean).join(', ') || '—'}</dd>
            </div>
          </dl>
        </Card>
      </div>
    </>
  );
}
