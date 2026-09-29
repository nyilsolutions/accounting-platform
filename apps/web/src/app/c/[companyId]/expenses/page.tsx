'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { formatMoney, parseMoney, sumMoney, type VendorBalanceDto } from '@acct/shared';
import { PurchaseTransactionsTable } from '@/components/purchases/transactions-table';
import { Card } from '@/components/ui';
import { api } from '@/lib/api';
import { keys, useAccess } from '@/lib/queries';

/** Money bar: unpaid bills, overdue bills and unused vendor credits. */
function MoneyBar({ companyId }: { companyId: string }) {
  const access = useAccess(companyId);
  const balances = useQuery({
    queryKey: [...keys.sales(companyId), 'vendor-balances'],
    queryFn: () => api<VendorBalanceDto[]>(`/companies/${companyId}/vendor-balances`),
  });
  if (!balances.data) return null;
  const sum = (f: (b: VendorBalanceDto) => string) =>
    sumMoney(balances.data.map((b) => parseMoney(f(b))));
  const tiles: Array<[string, bigint, string]> = [
    ['Unpaid bills', sum((b) => b.openBalance) + sum((b) => b.availableCredit), 'text-gray-900'],
    ['Overdue', sum((b) => b.overdueBalance), 'text-amber-700'],
    ['Unused vendor credits', sum((b) => b.availableCredit), 'text-gray-700'],
  ];
  return (
    <div className="mb-5 grid gap-4 sm:grid-cols-4" data-testid="expenses-money-bar">
      {tiles.map(([label, v, tone]) => (
        <Card key={label} className="p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
          <div className={`mt-1 text-xl font-semibold tabular-nums ${tone}`}>${formatMoney(v)}</div>
        </Card>
      ))}
      {access.can('purchases.manage') && (
        <Card className="flex flex-col justify-center gap-1 p-4 text-sm">
          <Link
            href={`/c/${companyId}/expenses/pay-bills`}
            className="text-brand-700 hover:underline"
          >
            Pay bills
          </Link>
          <Link
            href={`/c/${companyId}/expenses/print-checks`}
            className="text-brand-700 hover:underline"
          >
            Print checks
          </Link>
        </Card>
      )}
    </div>
  );
}

export default function ExpensesPage() {
  const { companyId } = useParams<{ companyId: string }>();
  return (
    <>
      <MoneyBar companyId={companyId} />
      <PurchaseTransactionsTable companyId={companyId} />
    </>
  );
}
