'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Card, PageHeader } from '@/components/ui';

const GROUPS: Array<{
  title: string;
  reports: Array<{ slug: string; title: string; description: string }>;
}> = [
  {
    title: 'Business overview',
    reports: [
      {
        slug: 'profit-and-loss',
        title: 'Profit and Loss',
        description:
          'Income and expenses for a period, and your net income (accrual or cash basis).',
      },
      {
        slug: 'balance-sheet',
        title: 'Balance Sheet',
        description: 'What you own, what you owe and your equity on a date.',
      },
    ],
  },
  {
    title: 'Who owes you',
    reports: [
      {
        slug: 'ar-aging-summary',
        title: 'A/R Aging Summary',
        description: 'Unpaid balances per customer, by how long they are overdue.',
      },
      {
        slug: 'ar-aging-detail',
        title: 'A/R Aging Detail',
        description: 'Every open invoice, credit and payment, grouped by days past due.',
      },
      {
        slug: 'open-invoices',
        title: 'Open Invoices',
        description: 'Unpaid invoices and unused credits by customer.',
      },
      {
        slug: 'customer-balance-summary',
        title: 'Customer Balance Summary',
        description: 'What each customer owes on a date.',
      },
    ],
  },
  {
    title: 'Sales and customers',
    reports: [
      {
        slug: 'sales-by-customer',
        title: 'Sales by Customer Summary',
        description: 'Net sales per customer for a period.',
      },
      {
        slug: 'sales-by-item',
        title: 'Sales by Product/Service Summary',
        description: 'Quantity, amount and average price per product or service.',
      },
    ],
  },
  {
    title: 'For my accountant',
    reports: [
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
    ],
  },
];

export default function ReportsPage() {
  const { companyId } = useParams<{ companyId: string }>();
  return (
    <>
      <PageHeader
        title="Reports"
        description="A/P, cash flow, sales tax and custom reports arrive in later phases."
      />
      <div className="space-y-8">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
              {g.title}
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {g.reports.map((r) => (
                <Link key={r.slug} href={`/c/${companyId}/reports/${r.slug}`}>
                  <Card className="h-full p-5 hover:border-brand-500">
                    <h3 className="font-semibold text-brand-700">{r.title}</h3>
                    <p className="mt-1 text-sm text-gray-600">{r.description}</p>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
