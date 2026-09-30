'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Card } from '@/components/ui';

const TOOLS = [
  {
    href: 'close',
    title: 'Close the books',
    text: 'The month-end checklist: reconciliations, Undeposited Funds, uncategorized amounts, client changes, revaluation. Then close the month.',
  },
  {
    href: 'review',
    title: 'Review client changes',
    text: 'What the client added, changed, voided or deleted since you last looked, with before and after. Changes in closed periods are flagged.',
  },
  {
    href: 'reclassify',
    title: 'Reclassify transactions',
    text: 'Move many lines to another account or class at once.',
  },
  {
    href: 'write-off',
    title: 'Write off invoices',
    text: 'Clear old, uncollectible invoices to Bad Debts. The sales tax on them stays owed.',
  },
  {
    href: 'undeposited',
    title: 'Fix undeposited funds',
    text: 'Match payments stuck in Undeposited Funds to deposits that were entered straight to income.',
  },
];

/** Accounting › Accountant tools (ADR 0021). */
export default function AccountantToolsPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const base = `/c/${companyId}/accounting/tools`;
  return (
    <div className="grid gap-4 md:grid-cols-2" data-testid="accountant-tools">
      {TOOLS.map((t) => (
        <Link key={t.href} href={`${base}/${t.href}`} className="block">
          <Card className="h-full p-5 hover:border-brand-400">
            <h2 className="font-semibold text-brand-700">{t.title}</h2>
            <p className="mt-1 text-sm text-gray-600">{t.text}</p>
          </Card>
        </Link>
      ))}
      <Link href={`/c/${companyId}/reports/adjusted-trial-balance`} className="block">
        <Card className="h-full p-5 hover:border-brand-400">
          <h2 className="font-semibold text-brand-700">Adjusted Trial Balance</h2>
          <p className="mt-1 text-sm text-gray-600">
            The trial balance before your adjusting entries, the adjustments, and after. Mark a
            journal entry &ldquo;adjusting&rdquo; to include it.
          </p>
        </Card>
      </Link>
    </div>
  );
}
