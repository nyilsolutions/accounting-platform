'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addDays,
  formatDate,
  formatMoney,
  monthStartOf,
  todayIso,
  TXN_TYPE_LABELS,
  type ReclassifyLineDto,
  type ReclassifyResultDto,
} from '@acct/shared';
import { useClosingPassword } from '@/components/ledger/closing-password';
import { AccountSelect } from '@/components/ledger/pickers';
import { Alert, Button, Card, Spinner, TextInput } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { txnHref } from '@/lib/links';
import {
  keys,
  ledgerKeys,
  useAccess,
  useAccounts,
  useLedgerSettings,
  useSimpleList,
} from '@/lib/queries';

/** Accounts lines never move to (as the API enforces). */
const FIXED_ROLES = [
  'undeposited_funds',
  'sales_tax_payable',
  'payroll_liabilities',
  'payroll_expenses',
  'inventory_asset',
  'exchange_gain_loss',
  'opening_balance_equity',
  'retained_earnings',
];

const lineKey = (l: { txnId: string; lineNo: number }) => `${l.txnId}:${l.lineNo}`;

/** Accountant tools › Reclassify transactions (ADR 0021). */
export default function ReclassifyPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const accounts = useAccounts(companyId);
  const settings = useLedgerSettings(companyId);
  const classes = useSimpleList(companyId, 'classes');
  const closing = useClosingPassword();
  const [filter, setFilter] = useState({
    accountId: '',
    from: monthStartOf(addDays(monthStartOf(todayIso()), -1)),
    to: todayIso(),
  });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [toAccount, setToAccount] = useState('');
  const [toClass, setToClass] = useState<string>('keep');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const qs = new URLSearchParams(
    Object.entries(filter).filter(([, v]) => v) as Array<[string, string]>,
  ).toString();
  const q = useQuery({
    queryKey: [...keys.accountant(companyId), 'reclassify', qs],
    queryFn: () => api<ReclassifyLineDto[]>(`/companies/${companyId}/accountant/reclassify?${qs}`),
  });
  const lines = q.data ?? [];
  const chosen = lines.filter((l) => picked.has(lineKey(l)));
  const blocked = toAccount ? chosen.filter((l) => !l.canChangeAccount) : [];

  async function apply() {
    setError(null);
    setNotice(null);
    try {
      await closing.run(async (closingPassword) => {
        const r = await api<ReclassifyResultDto>(`/companies/${companyId}/accountant/reclassify`, {
          method: 'POST',
          body: {
            lines: chosen.map((l) => ({ txnId: l.txnId, lineNo: l.lineNo })),
            ...(toAccount ? { accountId: toAccount } : {}),
            ...(toClass !== 'keep' ? { classId: toClass === 'none' ? null : toClass } : {}),
            closingPassword,
          },
        });
        setNotice(
          `${r.lines} line${r.lines === 1 ? '' : 's'} in ${r.transactions} transaction${r.transactions === 1 ? '' : 's'} reclassified.`,
        );
        setPicked(new Set());
        await Promise.all([
          qc.invalidateQueries({ queryKey: keys.accountant(companyId) }),
          ...ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })),
        ]);
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const useNumbers = settings.data?.useAccountNumbers ?? false;
  const classOptions = (classes.data ?? []).map((c) => ({ id: c.id, label: c.name }));
  return (
    <div className="space-y-4" data-testid="reclassify">
      <div>
        <h2 className="text-lg font-semibold">Reclassify transactions</h2>
        <p className="text-sm text-gray-600">
          Move lines to another account or class. Amounts don&apos;t change. Lines with a product or
          service keep its account; A/R, A/P, bank, card, sales tax, payroll and inventory lines
          aren&apos;t listed.
        </p>
      </div>
      <Card className="grid gap-3 p-4 md:grid-cols-4 md:items-end">
        <label className="block text-sm md:col-span-2">
          <span className="mb-1 block font-medium text-gray-700">Account</span>
          <AccountSelect
            aria-label="Filter by account"
            accounts={accounts.data ?? []}
            useNumbers={useNumbers}
            placeholder="Any account"
            value={filter.accountId}
            onChange={(e) => setFilter({ ...filter, accountId: e.target.value })}
          />
        </label>
        <TextInput
          label="From"
          type="date"
          value={filter.from}
          onChange={(e) => setFilter({ ...filter, from: e.target.value })}
        />
        <TextInput
          label="To"
          type="date"
          value={filter.to}
          onChange={(e) => setFilter({ ...filter, to: e.target.value })}
        />
      </Card>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {q.isPending ? (
        <Spinner />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full min-w-[760px] text-sm" data-testid="reclassify-lines">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="w-10 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={lines.length > 0 && picked.size === lines.length}
                    onChange={(e) =>
                      setPicked(e.target.checked ? new Set(lines.map(lineKey)) : new Set())
                    }
                  />
                </th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Transaction</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Account</th>
                <th className="px-3 py-2">Class</th>
                <th className="px-3 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {lines.map((l) => (
                <tr key={lineKey(l)}>
                  <td className="px-3 py-1.5">
                    <input
                      type="checkbox"
                      aria-label={`Select ${l.description ?? l.accountName} ${l.amount}`}
                      checked={picked.has(lineKey(l))}
                      onChange={(e) => {
                        const next = new Set(picked);
                        if (e.target.checked) next.add(lineKey(l));
                        else next.delete(lineKey(l));
                        setPicked(next);
                      }}
                    />
                  </td>
                  <td className="px-3 py-1.5">{formatDate(l.txnDate)}</td>
                  <td className="px-3 py-1.5">
                    <Link
                      href={txnHref(companyId, l.txnType, l.txnId)}
                      className="text-brand-700 hover:underline"
                    >
                      {TXN_TYPE_LABELS[l.txnType] ?? l.txnType} {l.number ?? ''}
                    </Link>
                    {l.description && <div className="text-xs text-gray-500">{l.description}</div>}
                  </td>
                  <td className="px-3 py-1.5">{l.partyName}</td>
                  <td className="px-3 py-1.5">
                    {l.accountName}
                    {!l.canChangeAccount && (
                      <span className="ml-1 text-xs text-gray-500">(product)</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">{l.className}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatMoney(l.amount)}</td>
                </tr>
              ))}
              {lines.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                    No lines match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {access.can('ledger.manage') && (
        <Card className="grid gap-3 p-4 md:grid-cols-4 md:items-end">
          <label className="block text-sm md:col-span-2">
            <span className="mb-1 block font-medium text-gray-700">Move to account</span>
            <AccountSelect
              aria-label="New account"
              accounts={(accounts.data ?? []).filter(
                (a) =>
                  !['accounts_receivable', 'accounts_payable', 'bank', 'credit_card'].includes(
                    a.accountType,
                  ) &&
                  !a.currency &&
                  !FIXED_ROLES.includes(a.systemRole ?? ''),
              )}
              useNumbers={useNumbers}
              placeholder="(keep the account)"
              value={toAccount}
              onChange={(e) => setToAccount(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Class</span>
            <select
              aria-label="New class"
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              value={toClass}
              onChange={(e) => setToClass(e.target.value)}
            >
              <option value="keep">(keep the class)</option>
              <option value="none">No class</option>
              {classOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <div>
            <Button
              type="button"
              disabled={
                chosen.length === 0 || (!toAccount && toClass === 'keep') || blocked.length > 0
              }
              onClick={apply}
            >
              Reclassify {chosen.length || ''} line{chosen.length === 1 ? '' : 's'}
            </Button>
            {blocked.length > 0 && (
              <p className="mt-1 text-xs text-red-700">
                {blocked.length} chosen line{blocked.length === 1 ? ' is a' : 's are'} product
                {blocked.length === 1 ? '' : 's'}: only the class can change.
              </p>
            )}
          </div>
        </Card>
      )}
      {closing.dialog}
    </div>
  );
}
