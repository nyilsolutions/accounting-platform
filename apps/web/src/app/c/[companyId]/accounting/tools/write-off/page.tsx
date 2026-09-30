'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatCurrency,
  formatDate,
  formatMoney,
  todayIso,
  type WriteOffCandidateDto,
  type WriteOffResultDto,
} from '@acct/shared';
import { useClosingPassword } from '@/components/ledger/closing-password';
import { AccountSelect } from '@/components/ledger/pickers';
import { Alert, Button, Card, Spinner, TextInput } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { txnHref } from '@/lib/links';
import { keys, ledgerKeys, useAccess, useAccounts, useLedgerSettings } from '@/lib/queries';

/** Accountant tools › Write off invoices (ADR 0021). */
export default function WriteOffPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const accounts = useAccounts(companyId);
  const settings = useLedgerSettings(companyId);
  const closing = useClosingPassword();
  const [filter, setFilter] = useState({ olderThanDays: '180', maxBalance: '', asOf: todayIso() });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [txnDate, setTxnDate] = useState(todayIso());
  const [accountId, setAccountId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const qs = new URLSearchParams(
    Object.entries(filter).filter(([, v]) => v) as Array<[string, string]>,
  ).toString();
  const q = useQuery({
    queryKey: [...keys.accountant(companyId), 'write-off', qs],
    queryFn: () =>
      api<WriteOffCandidateDto[]>(`/companies/${companyId}/accountant/write-off?${qs}`),
  });
  const rows = q.data ?? [];

  async function writeOff() {
    setError(null);
    setNotice(null);
    try {
      await closing.run(async (closingPassword) => {
        const r = await api<WriteOffResultDto>(`/companies/${companyId}/accountant/write-off`, {
          method: 'POST',
          body: {
            invoiceIds: [...picked],
            txnDate,
            ...(accountId ? { accountId } : {}),
            closingPassword,
          },
        });
        setNotice(
          `${r.writtenOff.length} invoice${r.writtenOff.length === 1 ? '' : 's'} written off: $${formatMoney(r.total)}.`,
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

  return (
    <div className="space-y-4" data-testid="write-off">
      <div>
        <h2 className="text-lg font-semibold">Write off invoices</h2>
        <p className="text-sm text-gray-600">
          Each invoice&apos;s open balance goes to a bad-debt account through a credit memo applied
          to it. The sales tax on the invoice stays owed; where the state allows a bad-debt
          deduction, enter it as a sales tax adjustment.
        </p>
      </div>
      <Card className="grid gap-3 p-4 md:grid-cols-3 md:items-end">
        <TextInput
          label="At least this many days past due"
          inputMode="numeric"
          value={filter.olderThanDays}
          onChange={(e) =>
            setFilter({ ...filter, olderThanDays: e.target.value.replace(/\D/g, '') })
          }
        />
        <TextInput
          label="Balance up to"
          inputMode="decimal"
          value={filter.maxBalance}
          onChange={(e) => setFilter({ ...filter, maxBalance: e.target.value })}
        />
        <TextInput
          label="As of"
          type="date"
          value={filter.asOf}
          onChange={(e) => setFilter({ ...filter, asOf: e.target.value })}
        />
      </Card>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {q.isPending ? (
        <Spinner />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full min-w-[640px] text-sm" data-testid="write-off-invoices">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="w-10 px-3 py-2" />
                <th className="px-3 py-2">Invoice</th>
                <th className="px-3 py-2">Customer</th>
                <th className="px-3 py-2">Due</th>
                <th className="px-3 py-2 text-right">Days past due</th>
                <th className="px-3 py-2 text-right">Open balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-1.5">
                    <input
                      type="checkbox"
                      aria-label={`Write off invoice ${r.number ?? r.id}`}
                      checked={picked.has(r.id)}
                      onChange={(e) => {
                        const next = new Set(picked);
                        if (e.target.checked) next.add(r.id);
                        else next.delete(r.id);
                        setPicked(next);
                      }}
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <Link
                      href={txnHref(companyId, 'invoice', r.id)}
                      className="text-brand-700 hover:underline"
                    >
                      {r.number ?? 'Invoice'}
                    </Link>{' '}
                    <span className="text-gray-500">({formatDate(r.txnDate)})</span>
                  </td>
                  <td className="px-3 py-1.5">{r.customerName}</td>
                  <td className="px-3 py-1.5">{r.dueDate ? formatDate(r.dueDate) : ''}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.daysPastDue}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {r.currency ? formatCurrency(r.balance, r.currency) : formatMoney(r.balance)}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                    No open invoices match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {access.can('ledger.manage') && (
        <Card className="grid gap-3 p-4 md:grid-cols-4 md:items-end">
          <TextInput
            label="Write-off date"
            type="date"
            value={txnDate}
            onChange={(e) => setTxnDate(e.target.value)}
          />
          <label className="block text-sm md:col-span-2">
            <span className="mb-1 block font-medium text-gray-700">Account</span>
            <AccountSelect
              aria-label="Write-off account"
              accounts={accounts.data ?? []}
              useNumbers={settings.data?.useAccountNumbers ?? false}
              types={['expense', 'other_expense']}
              placeholder="Bad Debts (created if missing)"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            />
          </label>
          <Button type="button" disabled={picked.size === 0} onClick={writeOff}>
            Write off {picked.size || ''} invoice{picked.size === 1 ? '' : 's'}
          </Button>
        </Card>
      )}
      {closing.dialog}
    </div>
  );
}
