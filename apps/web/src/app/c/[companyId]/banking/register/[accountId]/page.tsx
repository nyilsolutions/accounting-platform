'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CLEARED_MARKS,
  formatDate,
  formatDollars,
  formatMoney,
  parseMoney,
  TXN_TYPE_LABELS,
  type AccountType,
  type RegisterDto,
} from '@acct/shared';
import { Alert, Badge, Button, Card, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { txnHref } from '@/lib/links';
import { keys, ledgerKeys, useAccess } from '@/lib/queries';

const PAGE = 200;

/** Column headings: what lowers and what raises the balance, in the account's own terms. */
function columns(type: AccountType): [string, string] {
  if (type === 'bank') return ['Payment', 'Deposit'];
  if (type === 'credit_card') return ['Payment', 'Charge'];
  return ['Decrease', 'Increase'];
}

export default function RegisterPage() {
  const { companyId, accountId } = useParams<{ companyId: string; accountId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const register = useQuery({
    queryKey: [...keys.banking(companyId), 'register', accountId, { search, from, to, offset }],
    queryFn: () => {
      const qs = new URLSearchParams({ offset: String(offset), limit: String(PAGE) });
      if (search) qs.set('search', search);
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      return api<RegisterDto>(
        `/companies/${companyId}/banking/accounts/${accountId}/register?${qs}`,
      );
    },
  });
  if (register.isError) return <Alert>{errorMessage(register.error)}</Alert>;
  if (register.isPending) return <Spinner />;
  const r = register.data;
  const [down, up] = columns(r.accountType);
  const canManage = access.can('banking.manage');

  async function toggle(txnId: string, cleared: boolean) {
    setError(null);
    try {
      await api(`/companies/${companyId}/banking/accounts/${accountId}/cleared`, {
        method: 'POST',
        body: { transactionId: txnId, cleared },
      });
      await Promise.all(ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link
            href={`/c/${companyId}/banking?account=${accountId}`}
            className="text-sm text-brand-700 hover:underline"
          >
            ← Bank transactions
          </Link>
          <h2 className="text-xl font-semibold text-gray-900">{r.accountName} register</h2>
        </div>
        <dl className="flex gap-6 text-sm">
          <div>
            <dt className="text-gray-500">Ending balance</dt>
            <dd className="text-lg font-semibold tabular-nums" data-testid="register-balance">
              {formatDollars(r.endingBalance)}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Cleared balance</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {formatDollars(r.clearedBalance)}
            </dd>
          </div>
        </dl>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
          placeholder="Search payee, memo, number or amount"
          aria-label="Search register"
          className="w-72 rounded-md border border-gray-300 px-3 py-1.5"
        />
        <label className="flex items-center gap-2">
          From
          <input
            type="date"
            aria-label="From"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border border-gray-300 px-2 py-1"
          />
        </label>
        <label className="flex items-center gap-2">
          To
          <input
            type="date"
            aria-label="To"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-md border border-gray-300 px-2 py-1"
          />
        </label>
      </div>
      {error && (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      )}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm" data-testid="register">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Ref no.</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Payee</th>
                <th className="px-3 py-2">Account</th>
                <th className="px-3 py-2">Memo</th>
                <th className="px-3 py-2 text-right">{down}</th>
                <th className="px-3 py-2 text-right">{up}</th>
                <th className="px-3 py-2 text-center" title="Cleared (C) or reconciled (R)">
                  ✓
                </th>
                <th className="px-3 py-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {r.entries.map((e) => {
                const amount = parseMoney(e.amount);
                return (
                  <tr
                    key={e.txnId}
                    className="cursor-pointer hover:bg-gray-50"
                    onClick={() => router.push(txnHref(companyId, e.txnType, e.txnId))}
                  >
                    <td className="whitespace-nowrap px-3 py-1.5">{formatDate(e.txnDate)}</td>
                    <td className="px-3 py-1.5">{e.number}</td>
                    <td className="px-3 py-1.5">
                      {TXN_TYPE_LABELS[e.txnType] ?? e.txnType}{' '}
                      {e.fromBankFeed && <Badge>Bank</Badge>}
                    </td>
                    <td className="px-3 py-1.5">{e.payee}</td>
                    <td className="px-3 py-1.5">{e.otherAccount}</td>
                    <td className="max-w-[16rem] truncate px-3 py-1.5 text-gray-600">{e.memo}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {amount < 0n ? formatMoney(-amount) : ''}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {amount > 0n ? formatMoney(amount) : ''}
                    </td>
                    <td className="px-3 py-1.5 text-center" onClick={(ev) => ev.stopPropagation()}>
                      {e.cleared === 'reconciled' ? (
                        <span title="Reconciled" className="font-semibold text-gray-700">
                          {CLEARED_MARKS.reconciled}
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={!canManage}
                          aria-label={`${e.cleared ? 'Unclear' : 'Clear'} ${TXN_TYPE_LABELS[e.txnType] ?? e.txnType} ${e.number ?? ''} ${e.txnDate}`}
                          onClick={() => toggle(e.txnId, !e.cleared)}
                          className="h-6 w-6 rounded border border-gray-300 text-xs font-semibold text-emerald-700 hover:bg-gray-100"
                        >
                          {e.cleared ? CLEARED_MARKS.cleared : ''}
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {formatMoney(e.balance)}
                    </td>
                  </tr>
                );
              })}
              {r.entries.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-gray-500">
                    No transactions.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
      {r.total > PAGE && (
        <div className="mt-3 flex items-center gap-3 text-sm">
          <Button
            size="sm"
            variant="secondary"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}
          >
            Newer
          </Button>
          <span className="text-gray-600">
            {offset + 1}–{Math.min(offset + PAGE, r.total)} of {r.total}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={offset + PAGE >= r.total}
            onClick={() => setOffset(offset + PAGE)}
          >
            Older
          </Button>
        </div>
      )}
    </>
  );
}
