'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ACCOUNT_TYPE_INFO, formatCurrency, formatMoney, type AccountDto } from '@acct/shared';
import { AccountForm } from '@/components/ledger/account-form';
import { Alert, Badge, Button, Card, Dialog, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAccess, useAccounts, useLedgerSettings } from '@/lib/queries';

export default function ChartOfAccountsPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const settings = useLedgerSettings(companyId);
  const [showInactive, setShowInactive] = useState(false);
  const [filter, setFilter] = useState('');
  const accounts = useAccounts(companyId, showInactive);
  const [editing, setEditing] = useState<AccountDto | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (accounts.isPending || settings.isPending) return <Spinner />;
  const canManage = access.can('ledger.manage');
  const canReport = access.can('reports.view');
  const useNumbers = settings.data?.useAccountNumbers ?? false;
  const list = accounts.data ?? [];
  const q = filter.trim().toLowerCase();
  const visible = q
    ? list.filter((a) =>
        `${a.number ?? ''} ${a.fullName} ${a.detailType ?? ''}`.toLowerCase().includes(q),
      )
    : list;

  const refresh = () => qc.invalidateQueries({ queryKey: ['company', companyId, 'accounts'] });

  async function toggleActive(a: AccountDto) {
    setError(null);
    try {
      await api(`/companies/${companyId}/accounts/${a.id}`, {
        method: 'PATCH',
        body: { isActive: !a.isActive },
      });
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (list.length === 0 && !showInactive) {
    return (
      <Card className="max-w-xl p-6">
        <h2 className="font-semibold">No chart of accounts yet</h2>
        <p className="mt-2 text-sm text-gray-600">
          Start from our standard small-business chart of accounts, matched to your tax form. You
          can rename, add or deactivate accounts afterwards.
        </p>
        {canManage && (
          <Button
            className="mt-4"
            onClick={async () => {
              await api(`/companies/${companyId}/accounts/setup-default`, { method: 'POST' });
              await refresh();
            }}
          >
            Create standard chart of accounts
          </Button>
        )}
      </Card>
    );
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name or number"
            aria-label="Filter accounts"
            className="w-64 rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />{' '}
            Include inactive
          </label>
        </div>
        {canManage && <Button onClick={() => setEditing('new')}>New account</Button>}
      </div>
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                {useNumbers && <th className="px-4 py-2">Number</th>}
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Detail type</th>
                <th className="px-4 py-2 text-right">Balance</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visible.map((a) => (
                <tr
                  key={a.id}
                  className={a.isActive ? '' : 'text-gray-400'}
                  data-testid={`account-${a.fullName}`}
                >
                  {useNumbers && <td className="px-4 py-2 font-mono text-xs">{a.number}</td>}
                  <td className="px-4 py-2" style={{ paddingLeft: `${1 + a.depth * 1.25}rem` }}>
                    {a.name} {!a.isActive && <Badge>Inactive</Badge>}
                  </td>
                  <td className="px-4 py-2">{ACCOUNT_TYPE_INFO[a.accountType].label}</td>
                  <td className="px-4 py-2 text-gray-600">{a.detailType}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {a.balance !== null ? formatMoney(a.balance) : ''}
                    {a.foreignBalance !== null && (
                      <div className="text-xs text-gray-500">
                        {formatCurrency(a.foreignBalance, a.currency)}
                      </div>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    {canReport && (
                      <Link
                        href={`/c/${companyId}/reports/general-ledger?accountId=${a.id}`}
                        className="mr-3 text-brand-700 hover:underline"
                      >
                        Report
                      </Link>
                    )}
                    {canManage && (
                      <>
                        <button
                          className="mr-3 text-brand-700 hover:underline"
                          onClick={() => setEditing(a)}
                        >
                          Edit
                        </button>
                        {!a.systemRole && (
                          <button
                            className="text-gray-600 hover:underline"
                            onClick={() => toggleActive(a)}
                          >
                            {a.isActive ? 'Make inactive' : 'Make active'}
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'New account' : 'Edit account'}
        wide
      >
        {editing !== null && (
          <AccountForm
            initial={editing === 'new' ? undefined : editing}
            accounts={list}
            useNumbers={useNumbers}
            onCancel={() => setEditing(null)}
            onSubmit={async (input) => {
              if (editing === 'new')
                await api(`/companies/${companyId}/accounts`, { method: 'POST', body: input });
              else
                await api(`/companies/${companyId}/accounts/${editing.id}`, {
                  method: 'PATCH',
                  body: input,
                });
              await refresh();
              setEditing(null);
            }}
          />
        )}
      </Dialog>
    </>
  );
}
