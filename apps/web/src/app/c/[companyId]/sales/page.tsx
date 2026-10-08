'use client';

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { formatMoney, parseMoney, sumMoney, type CustomerBalanceDto } from '@acct/shared';
import { SalesTransactionsTable } from '@/components/sales/transactions-table';
import { Card } from '@/components/ui';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';

/** Money bar: what customers owe, what is overdue, and unused credits. */
function MoneyBar({ companyId }: { companyId: string }) {
  const balances = useQuery({
    queryKey: [...keys.sales(companyId), 'balances'],
    queryFn: () => api<CustomerBalanceDto[]>(`/companies/${companyId}/customer-balances`),
  });
  if (!balances.data) return null;
  const sum = (f: (b: CustomerBalanceDto) => string) =>
    sumMoney(balances.data.map((b) => parseMoney(f(b))));
  const open = sum((b) => b.openBalance) + sum((b) => b.availableCredit);
  const tiles: Array<[string, bigint, string]> = [
    ['Open invoices', open, 'text-gray-900'],
    ['Overdue', sum((b) => b.overdueBalance), 'text-amber-700'],
    ['Unused credits', sum((b) => b.availableCredit), 'text-gray-700'],
  ];
  return (
    <div className="mb-5 grid gap-4 sm:grid-cols-3" data-testid="sales-money-bar">
      {tiles.map(([label, v, tone]) => (
        <Card key={label} className="p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
          <div className={`mt-1 text-xl font-semibold tabular-nums ${tone}`}>${formatMoney(v)}</div>
        </Card>
      ))}
    </div>
  );
}

export default function SalesPage() {
  const { companyId } = useParams<{ companyId: string }>();
  return (
    <>
      <MoneyBar companyId={companyId} />
      <SalesTransactionsTable companyId={companyId} />
    </>
  );
}
