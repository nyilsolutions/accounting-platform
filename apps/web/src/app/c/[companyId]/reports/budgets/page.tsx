'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BUDGET_DIMENSION_LABELS,
  BUDGET_DIMENSIONS,
  formatDate,
  formatMoney,
  todayIso,
  type BudgetDto,
  type BudgetSummaryDto,
} from '@acct/shared';
import { Alert, Button, Card, PageHeader, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, useAccess } from '@/lib/queries';

export default function BudgetsPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const canManage = access.can('budgets.manage');
  const list = useQuery({
    queryKey: [...keys.budgets(companyId), 'list'],
    queryFn: () => api<BudgetSummaryDto[]>(`/companies/${companyId}/budgets`),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const year = Number(todayIso().slice(0, 4));

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const b = await api<BudgetDto>(`/companies/${companyId}/budgets`, {
        method: 'POST',
        body: {
          name: String(f.get('name') ?? ''),
          startDate: `${String(f.get('start'))}-01`,
          dimension: String(f.get('dimension') ?? 'none'),
        },
      });
      await qc.invalidateQueries({ queryKey: keys.budgets(companyId) });
      router.push(`/c/${companyId}/reports/budgets/${b.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="mb-4 text-sm">
        <Link href={`/c/${companyId}/reports`} className="text-brand-700 hover:underline">
          ← Reports
        </Link>
      </div>
      <PageHeader
        title="Budgets"
        description="Twelve months of planned income and expenses. Compare them with actuals in Budget vs. Actuals."
      />
      {canManage && (
        <Card className="mb-6 p-4">
          <form onSubmit={create} className="flex flex-wrap items-end gap-3 text-sm">
            <label>
              <span className="mb-1 block font-medium text-gray-700">Name</span>
              <input
                name="name"
                aria-label="Budget name"
                required
                maxLength={100}
                defaultValue={`FY${year + 1} budget`}
                className="rounded-md border border-gray-300 px-2 py-1.5"
              />
            </label>
            <label>
              <span className="mb-1 block font-medium text-gray-700">First month</span>
              <input
                type="month"
                name="start"
                aria-label="First month"
                required
                defaultValue={`${year + 1}-01`}
                className="rounded-md border border-gray-300 px-2 py-1.5"
              />
            </label>
            <label>
              <span className="mb-1 block font-medium text-gray-700">Amounts by</span>
              <select
                name="dimension"
                aria-label="Amounts by"
                className="rounded-md border border-gray-300 px-2 py-1.5"
              >
                {BUDGET_DIMENSIONS.map((d) => (
                  <option key={d} value={d}>
                    {BUDGET_DIMENSION_LABELS[d]}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" loading={busy}>
              Create budget
            </Button>
          </form>
          {error && (
            <div className="mt-3">
              <Alert>{error}</Alert>
            </div>
          )}
        </Card>
      )}
      {list.isPending ? (
        <Spinner />
      ) : (list.data ?? []).length === 0 ? (
        <Card className="p-6 text-sm text-gray-600">No budgets yet.</Card>
      ) : (
        <Card>
          <table className="w-full text-sm" data-testid="budgets">
            <thead className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Period</th>
                <th className="px-4 py-2">Amounts by</th>
                <th className="px-4 py-2 text-right">Budgeted net income</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {list.data!.map((b) => (
                <tr key={b.id}>
                  <td className="px-4 py-2">
                    <Link
                      href={`/c/${companyId}/reports/budgets/${b.id}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {b.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    {formatDate(b.startDate)} – {formatDate(b.endDate)}
                  </td>
                  <td className="px-4 py-2">{BUDGET_DIMENSION_LABELS[b.dimension]}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatMoney(b.netIncome)}</td>
                  <td className="px-4 py-2 text-right">
                    <Link
                      href={`/c/${companyId}/reports/budget-vs-actuals?budgetId=${b.id}&from=${b.startDate}&to=${b.endDate}`}
                      className="text-brand-700 hover:underline"
                    >
                      Budget vs. Actuals
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
