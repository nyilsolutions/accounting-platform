'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ACCOUNT_TYPE_INFO,
  addMonths,
  BUDGET_DIMENSION_LABELS,
  formatMoney,
  moneyToString,
  parseMoney,
  tryParseMoney,
  type AccountType,
  type BudgetDto,
  type BudgetRowDto,
  type Money,
} from '@acct/shared';
import { Alert, Badge, Button, Card, cx, PageHeader, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, useAccess, useAccounts, useCustomers, useSimpleList } from '@/lib/queries';

const PL_SECTIONS: Array<{ title: string; types: AccountType[]; sign: 1n | -1n }> = [
  { title: 'Income', types: ['income'], sign: 1n },
  { title: 'Cost of Goods Sold', types: ['cost_of_goods_sold'], sign: -1n },
  { title: 'Expenses', types: ['expense'], sign: -1n },
  { title: 'Other Income', types: ['other_income'], sign: 1n },
  { title: 'Other Expenses', types: ['other_expense'], sign: -1n },
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type Grid = Record<string, string[]>; // "accountId|dimensionId" → 12 cells as typed
const keyOf = (accountId: string, dim: string | null) => `${accountId}|${dim ?? ''}`;
const cellValue = (v: string | undefined): Money => (v ? (tryParseMoney(v) ?? 0n) : 0n);

export default function BudgetEditorPage() {
  const { companyId, id } = useParams<{ companyId: string; id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const canManage = access.can('budgets.manage');
  const budget = useQuery({
    queryKey: [...keys.budgets(companyId), id],
    queryFn: () => api<BudgetDto>(`/companies/${companyId}/budgets/${id}`),
  });
  const accounts = useAccounts(companyId, true);
  const classes = useSimpleList(companyId, 'classes');
  const locations = useSimpleList(companyId, 'locations');
  const customers = useCustomers(companyId, true, budget.data?.dimension === 'customer');
  const [grid, setGrid] = useState<Grid | null>(null);
  const [dimension, setDimension] = useState<string>('');
  const [percent, setPercent] = useState('0');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!budget.data || grid) return;
    const g: Grid = {};
    for (const r of budget.data.rows)
      g[keyOf(r.accountId, r.dimensionId)] = r.amounts.map((a) => a ?? '');
    setGrid(g);
  }, [budget.data, grid]);

  const dimOptions = useMemo(() => {
    const d = budget.data?.dimension;
    const list =
      d === 'class'
        ? (classes.data ?? []).map((c) => ({ id: c.id, label: c.name }))
        : d === 'location'
          ? (locations.data ?? []).map((c) => ({ id: c.id, label: c.name }))
          : d === 'customer'
            ? (customers.data ?? []).map((c) => ({ id: c.id, label: c.displayName }))
            : [];
    return [...list, { id: '', label: 'Not specified' }];
  }, [budget.data?.dimension, classes.data, locations.data, customers.data]);

  if (budget.isPending || accounts.isPending || !grid) return <Spinner />;
  if (budget.isError) return <Alert>{errorMessage(budget.error)}</Alert>;
  const b = budget.data!;
  const dim = b.dimension === 'none' ? null : dimension || null;
  const plAccounts = (accounts.data ?? []).filter(
    (a) =>
      ACCOUNT_TYPE_INFO[a.accountType].statement === 'profit_and_loss' &&
      (a.isActive || Object.keys(grid).some((k) => k.startsWith(`${a.id}|`))),
  );
  const monthLabels = b.months.map((m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`);

  function setCell(accountId: string, month: number, value: string) {
    const k = keyOf(accountId, dim);
    const row = [...(grid![k] ?? Array.from({ length: 12 }, () => ''))];
    row[month] = value;
    setGrid({ ...grid!, [k]: row });
  }
  function copyAcross(accountId: string) {
    const k = keyOf(accountId, dim);
    const first = grid![k]?.[0] ?? '';
    setGrid({ ...grid!, [k]: Array.from({ length: 12 }, () => first) });
  }

  async function fillFromActuals() {
    setBusy('actuals');
    setError(null);
    try {
      const rows = await api<BudgetRowDto[]>(
        `/companies/${companyId}/budgets/actuals?startDate=${addMonths(b.startDate, -12)}&dimension=${b.dimension}`,
      );
      const factor = BigInt(Math.round(Number(percent || '0') * 100)); // basis points
      const g: Grid = { ...grid! };
      for (const r of rows) {
        g[keyOf(r.accountId, r.dimensionId)] = r.amounts.map((a) => {
          if (!a) return '';
          const v = parseMoney(a);
          const adjusted = v + (v * factor) / 10_000n;
          return moneyToString(adjusted);
        });
      }
      setGrid(g);
      setNotice(
        `Filled with actuals from the twelve months before ${b.startDate}${percent !== '0' ? `, adjusted by ${percent}%` : ''}. Save to keep them.`,
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy('save');
    setError(null);
    setNotice(null);
    try {
      const rows = Object.entries(grid!)
        .filter(([, cells]) => cells.some((c) => c.trim()))
        .map(([k, cells]) => {
          const [accountId, dimensionId] = k.split('|');
          return {
            accountId: accountId!,
            dimensionId: dimensionId || null,
            amounts: cells.map((c) => {
              const v = tryParseMoney(c);
              return v === null || v === 0n ? null : moneyToString(v);
            }),
          };
        });
      const saved = await api<BudgetDto>(`/companies/${companyId}/budgets/${id}/amounts`, {
        method: 'PUT',
        body: { rows },
      });
      qc.setQueryData([...keys.budgets(companyId), id], saved);
      await qc.invalidateQueries({ queryKey: [...keys.budgets(companyId), 'list'] });
      setNotice('Budget saved.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete the budget "${b.name}"?`)) return;
    try {
      await api(`/companies/${companyId}/budgets/${id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: keys.budgets(companyId) });
      router.push(`/c/${companyId}/reports/budgets`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  // Totals per month for the dimension on screen.
  const net = Array.from({ length: 12 }, () => 0n);
  const sectionTotals = PL_SECTIONS.map((s) => {
    const t = Array.from({ length: 12 }, () => 0n);
    for (const a of plAccounts.filter((x) => s.types.includes(x.accountType))) {
      const cells = grid[keyOf(a.id, dim)] ?? [];
      cells.forEach((c, i) => {
        t[i] = t[i]! + cellValue(c);
        net[i] = net[i]! + s.sign * cellValue(c);
      });
    }
    return t;
  });
  const sum = (v: Money[]) => v.reduce((s, x) => s + x, 0n);

  return (
    <>
      <div className="mb-4 text-sm">
        <Link href={`/c/${companyId}/reports/budgets`} className="text-brand-700 hover:underline">
          ← Budgets
        </Link>
      </div>
      <PageHeader
        title={b.name}
        description={`${monthLabels[0]} – ${monthLabels[11]}. Enter income and expenses as positive amounts.`}
        actions={
          <div className="flex gap-2">
            <Link
              href={`/c/${companyId}/reports/budget-vs-actuals?budgetId=${b.id}&from=${b.startDate}&to=${b.endDate}`}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Budget vs. Actuals
            </Link>
            {canManage && (
              <Button variant="ghost" onClick={remove}>
                Delete
              </Button>
            )}
          </div>
        }
      />
      {error && (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      )}
      {notice && (
        <div className="mb-3">
          <Alert kind="success">{notice}</Alert>
        </div>
      )}
      <Card className="mb-4 flex flex-wrap items-end gap-3 p-3 text-sm">
        {b.dimension !== 'none' && (
          <label>
            <span className="mb-1 block font-medium text-gray-700">
              {BUDGET_DIMENSION_LABELS[b.dimension]
                .replace('Accounts by ', '')
                .replace(/^./, (c) => c.toUpperCase())}
            </span>
            <select
              aria-label="Budget for"
              value={dimension}
              onChange={(e) => setDimension(e.target.value)}
              className="rounded-md border border-gray-300 px-2 py-1.5"
            >
              {dimOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {canManage && (
          <>
            <label>
              <span className="mb-1 block font-medium text-gray-700">Adjust by %</span>
              <input
                aria-label="Adjust by percent"
                value={percent}
                onChange={(e) => setPercent(e.target.value)}
                inputMode="decimal"
                className="w-20 rounded-md border border-gray-300 px-2 py-1.5 text-right"
              />
            </label>
            <Button variant="secondary" loading={busy === 'actuals'} onClick={fillFromActuals}>
              Fill from last year’s actuals
            </Button>
            <Button className="ml-auto" loading={busy === 'save'} onClick={save}>
              Save budget
            </Button>
          </>
        )}
        {!canManage && <Badge>Read only</Badge>}
      </Card>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[1200px] text-sm" data-testid="budget-grid">
          <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="sticky left-0 bg-gray-50 px-3 py-2 text-left">Account</th>
              {monthLabels.map((m) => (
                <th key={m} className="px-1 py-2 text-right">
                  {m}
                </th>
              ))}
              <th className="px-3 py-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {PL_SECTIONS.map((s, si) => {
              const list = plAccounts.filter((a) => s.types.includes(a.accountType));
              if (!list.length) return null;
              return [
                <tr key={s.title} className="bg-gray-50/50 font-semibold">
                  <td className="sticky left-0 bg-white px-3 py-1.5" colSpan={14}>
                    {s.title}
                  </td>
                </tr>,
                ...list.map((a) => {
                  const cells = grid[keyOf(a.id, dim)] ?? [];
                  return (
                    <tr key={a.id} className="border-t border-gray-100">
                      <td
                        className="sticky left-0 whitespace-nowrap bg-white px-3 py-1"
                        style={{ paddingLeft: `${a.depth * 1 + 0.75}rem` }}
                      >
                        {a.name}
                        {canManage && (
                          <button
                            type="button"
                            className="ml-2 text-xs text-brand-700 hover:underline"
                            title="Copy the first month across"
                            aria-label={`Copy ${a.name} across`}
                            onClick={() => copyAcross(a.id)}
                          >
                            →
                          </button>
                        )}
                      </td>
                      {Array.from({ length: 12 }, (_, i) => (
                        <td key={i} className="px-0.5 py-0.5">
                          <input
                            aria-label={`${a.name} ${monthLabels[i]}`}
                            inputMode="decimal"
                            value={cells[i] ?? ''}
                            disabled={!canManage}
                            onChange={(e) => setCell(a.id, i, e.target.value)}
                            className={cx(
                              'w-20 rounded border border-transparent px-1 py-0.5 text-right tabular-nums hover:border-gray-300 focus:border-brand-500',
                              cells[i] && tryParseMoney(cells[i]!) === null && '!border-red-400',
                            )}
                          />
                        </td>
                      ))}
                      <td className="px-3 py-1 text-right tabular-nums">
                        {formatMoney(sum(cells.map(cellValue)))}
                      </td>
                    </tr>
                  );
                }),
                <tr key={`${s.title}-total`} className="border-t border-gray-200 font-medium">
                  <td className="sticky left-0 bg-white px-3 py-1">Total {s.title}</td>
                  {sectionTotals[si]!.map((v, i) => (
                    <td key={i} className="px-1 py-1 text-right tabular-nums">
                      {formatMoney(v)}
                    </td>
                  ))}
                  <td className="px-3 py-1 text-right tabular-nums">
                    {formatMoney(sum(sectionTotals[si]!))}
                  </td>
                </tr>,
              ];
            })}
            <tr className="border-t-2 border-gray-800 font-bold">
              <td className="sticky left-0 bg-white px-3 py-2">Net Income</td>
              {net.map((v, i) => (
                <td key={i} className="px-1 py-2 text-right tabular-nums">
                  {formatMoney(v)}
                </td>
              ))}
              <td className="px-3 py-2 text-right tabular-nums" data-testid="budget-net-income">
                {formatMoney(sum(net))}
              </td>
            </tr>
          </tbody>
        </table>
      </Card>
    </>
  );
}
