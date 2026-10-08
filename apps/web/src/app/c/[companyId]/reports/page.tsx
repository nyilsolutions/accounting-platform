'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Card, PageHeader } from '@/components/ui';

const REPORTS = [
  {
    slug: 'profit-and-loss',
    title: 'Profit and Loss',
    description: 'Income and expenses for a period, and your net income.',
  },
  {
    slug: 'balance-sheet',
    title: 'Balance Sheet',
    description: 'What you own, what you owe and your equity on a date.',
  },
  {
    slug: 'trial-balance',
    title: 'Trial Balance',
    description: 'Debit and credit balances of every account; used to check the books.',
  },
  {
    slug: 'general-ledger',
    title: 'General Ledger',
    description: 'Every transaction by account with running balances.',
  },
];

export default function ReportsPage() {
  const { companyId } = useParams<{ companyId: string }>();
  return (
    <>
      <PageHeader
        title="Reports"
        description="More reports (A/R and A/P aging, sales, cash flow, custom reports) arrive in later phases."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {REPORTS.map((r) => (
          <Link key={r.slug} href={`/c/${companyId}/reports/${r.slug}`}>
            <Card className="h-full p-5 hover:border-brand-500">
              <h2 className="font-semibold text-brand-700">{r.title}</h2>
              <p className="mt-1 text-sm text-gray-600">{r.description}</p>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
