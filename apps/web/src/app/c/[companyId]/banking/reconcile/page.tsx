'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ACCOUNT_TYPES,
  formatDate,
  formatMoney,
  isRegisterAccountType,
  parseMoney,
  todayIso,
  TXN_TYPE_LABELS,
  type ReconcileItemDto,
  type ReconciliationDto,
  type ReconciliationSummaryDto,
} from '@acct/shared';
import { AccountSelect } from '@/components/ledger/pickers';
import { useSalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Badge, Button, Card, cx, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, ledgerKeys, useAccess } from '@/lib/queries';

const REGISTER_TYPES = ACCOUNT_TYPES.filter(isRegisterAccountType);
const inputClass = 'block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm';

function Reconcile() {
  const { companyId } = useParams<{ companyId: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const access = useAccess(companyId);
  const { ready, lookups } = useSalesLookups(companyId);
  const firstBank = lookups.accounts.find((a) => a.accountType === 'bank' && a.isActive);
  const accountId = params.get('account') ?? firstBank?.id ?? '';
  const current = useQuery({
    queryKey: [...keys.banking(companyId), 'reconciliation', accountId],
    queryFn: () =>
      api<{ reconciliation: ReconciliationDto | null }>(
        `/companies/${companyId}/banking/accounts/${accountId}/reconciliations/current`,
      ),
    enabled: !!accountId,
  });
  if (!ready) return <Spinner />;
  const canManage = access.can('banking.manage');

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end gap-4">
        <label className="block w-72 text-sm">
          <span className="mb-1 block font-medium text-gray-700">Account to reconcile</span>
          <AccountSelect
            aria-label="Account to reconcile"
            accounts={lookups.accounts}
            useNumbers={lookups.useNumbers}
            types={REGISTER_TYPES}
            value={accountId}
            onChange={(e) =>
              router.replace(`/c/${companyId}/banking/reconcile?account=${e.target.value}`)
            }
          />
        </label>
      </div>
      {!accountId ? null : current.isPending ? (
        <Spinner />
      ) : current.isError ? (
        <Alert>{errorMessage(current.error)}</Alert>
      ) : current.data.reconciliation ? (
        <Worksheet
          key={current.data.reconciliation.id}
          companyId={companyId}
          initial={current.data.reconciliation}
          canManage={canManage}
        />
      ) : (
        <>
          {canManage && <StartForm companyId={companyId} accountId={accountId} />}
          <History companyId={companyId} accountId={accountId} canManage={canManage} />
        </>
      )}
    </>
  );
}

function StartForm({ companyId, accountId }: { companyId: string; accountId: string }) {
  const qc = useQueryClient();
  const [statementDate, setStatementDate] = useState(todayIso());
  const [endingBalance, setEndingBalance] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function start() {
    setError(null);
    setPending(true);
    try {
      await api(`/companies/${companyId}/banking/accounts/${accountId}/reconciliations`, {
        method: 'POST',
        body: { statementDate, endingBalance },
      });
      await qc.invalidateQueries({ queryKey: keys.banking(companyId) });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <Card className="mb-6 max-w-2xl p-5">
      <h2 className="mb-1 font-semibold text-gray-900">Start reconciling</h2>
      <p className="mb-4 text-sm text-gray-600">
        Enter the ending date and balance from your statement.
      </p>
      {error && (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      )}
      <form
        className="grid items-end gap-4 md:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">Statement ending date</span>
          <input
            type="date"
            aria-label="Statement ending date"
            required
            value={statementDate}
            onChange={(e) => setStatementDate(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">Ending balance</span>
          <input
            aria-label="Ending balance"
            inputMode="decimal"
            required
            value={endingBalance}
            onChange={(e) => setEndingBalance(e.target.value)}
            className={cx(inputClass, 'text-right tabular-nums')}
          />
        </label>
        <Button type="submit" loading={pending}>
          Start reconciling
        </Button>
      </form>
    </Card>
  );
}

function History({
  companyId,
  accountId,
  canManage,
}: {
  companyId: string;
  accountId: string;
  canManage: boolean;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const history = useQuery({
    queryKey: [...keys.banking(companyId), 'reconciliations', accountId],
    queryFn: () =>
      api<ReconciliationSummaryDto[]>(
        `/companies/${companyId}/banking/accounts/${accountId}/reconciliations`,
      ),
  });
  async function undo(r: ReconciliationSummaryDto) {
    if (
      !confirm(
        `Undo the reconciliation for the statement ending ${formatDate(r.statementDate)}? Its transactions go back to cleared.`,
      )
    )
      return;
    setError(null);
    try {
      await api(`/companies/${companyId}/reconciliations/${r.id}/undo`, {
        method: 'POST',
        body: {},
      });
      await Promise.all(ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })));
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  const rows = (history.data ?? []).filter((r) => r.status !== 'in_progress');
  return (
    <>
      <h2 className="mb-2 font-semibold text-gray-900">History</h2>
      {error && (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      )}
      <Card>
        <table className="w-full text-sm" data-testid="reconciliation-history">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-2">Statement ending</th>
              <th className="px-4 py-2 text-right">Beginning balance</th>
              <th className="px-4 py-2 text-right">Ending balance</th>
              <th className="px-4 py-2">Reconciled</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2">{formatDate(r.statementDate)}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {formatMoney(r.beginningBalance)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {formatMoney(r.endingBalance)}
                </td>
                <td className="px-4 py-2">
                  {r.status === 'undone' ? (
                    <Badge tone="amber">Undone</Badge>
                  ) : (
                    <span className="text-gray-600">
                      {r.completedAt && new Date(r.completedAt).toLocaleDateString()}{' '}
                      {r.completedByName && `by ${r.completedByName}`}
                    </span>
                  )}
                </td>
                <td className="space-x-3 px-4 py-2 text-right">
                  <Link
                    href={`/c/${companyId}/banking/reconcile/${r.id}/report`}
                    className="text-brand-700 hover:underline"
                  >
                    Report
                  </Link>
                  {canManage && r.canUndo && (
                    <button
                      type="button"
                      className="text-red-700 hover:underline"
                      onClick={() => undo(r)}
                    >
                      Undo
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-gray-500">
                  Not reconciled yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}

/** Tick what's on the statement until the difference is zero. */
function Worksheet({
  companyId,
  initial,
  canManage,
}: {
  companyId: string;
  initial: ReconciliationDto;
  canManage: boolean;
}) {
  const qc = useQueryClient();
  const router = useRouter();
  const [rec, setRec] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [statementDate, setStatementDate] = useState(initial.statementDate);
  const [endingBalance, setEndingBalance] = useState(initial.endingBalance);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const card = rec.accountType === 'credit_card';
  const difference = parseMoney(rec.difference);

  async function update(body: object) {
    setError(null);
    try {
      setRec(
        await api<ReconciliationDto>(`/companies/${companyId}/reconciliations/${rec.id}`, {
          method: 'PUT',
          body,
        }),
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  async function finish() {
    setError(null);
    setPending(true);
    try {
      await api(`/companies/${companyId}/reconciliations/${rec.id}/finish`, {
        method: 'POST',
        body: {},
      });
      await Promise.all(ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })));
      router.push(`/c/${companyId}/banking/reconcile/${rec.id}/report`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  async function cancel() {
    if (!confirm('Cancel this reconciliation? Ticked transactions stay cleared.')) return;
    await api(`/companies/${companyId}/reconciliations/${rec.id}`, { method: 'DELETE' });
    await qc.invalidateQueries({ queryKey: keys.banking(companyId) });
  }

  const sections: Array<[string, ReconcileItemDto[]]> = [
    [
      card ? 'Payments and credits' : 'Checks and payments',
      rec.items.filter((i) => parseMoney(i.amount) < 0n),
    ],
    [
      card ? 'Charges and cash advances' : 'Deposits and other credits',
      rec.items.filter((i) => parseMoney(i.amount) > 0n),
    ],
  ];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Reconcile {rec.accountName}</h2>
          <p className="text-sm text-gray-600">
            Statement ending {formatDate(rec.statementDate)}{' '}
            {canManage && (
              <button
                type="button"
                className="text-brand-700 hover:underline"
                onClick={() => setEditing(!editing)}
              >
                Edit info
              </button>
            )}
          </p>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <Button variant="ghost" onClick={cancel}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={() => router.push(`/c/${companyId}/banking`)}>
              Save for later
            </Button>
            <Button onClick={finish} loading={pending} disabled={difference !== 0n}>
              Finish now
            </Button>
          </div>
        )}
      </div>
      {editing && (
        <Card className="mb-4 flex flex-wrap items-end gap-4 p-4 text-sm">
          <label className="block">
            <span className="mb-1 block font-medium text-gray-700">Statement ending date</span>
            <input
              type="date"
              aria-label="Edit statement date"
              value={statementDate}
              onChange={(e) => setStatementDate(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="mb-1 block font-medium text-gray-700">Ending balance</span>
            <input
              aria-label="Edit ending balance"
              value={endingBalance}
              onChange={(e) => setEndingBalance(e.target.value)}
              className={cx(inputClass, 'text-right')}
            />
          </label>
          <Button
            onClick={async () => {
              await update({ statementDate, endingBalance });
              setEditing(false);
            }}
          >
            Save
          </Button>
        </Card>
      )}
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}
      <Card
        className="mb-5 grid grid-cols-2 gap-4 p-4 text-sm md:grid-cols-4"
        data-testid="reconcile-summary"
      >
        {(
          [
            ['Statement ending balance', rec.endingBalance],
            ['Beginning balance', rec.beginningBalance],
            ['Cleared balance', rec.clearedBalance],
            ['Difference', rec.difference],
          ] as const
        ).map(([label, v]) => (
          <div key={label}>
            <div className="text-gray-500">{label}</div>
            <div
              className={cx(
                'text-lg font-semibold tabular-nums',
                label === 'Difference' && (difference === 0n ? 'text-emerald-700' : 'text-red-700'),
              )}
              data-testid={label === 'Difference' ? 'reconcile-difference' : undefined}
            >
              {formatMoney(v)}
            </div>
          </div>
        ))}
      </Card>
      <div className="grid gap-5 lg:grid-cols-2">
        {sections.map(([label, items]) => {
          const all = items.length > 0 && items.every((i) => i.cleared);
          return (
            <Card key={label}>
              <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2">
                <h3 className="font-semibold text-gray-900">{label}</h3>
                <span className="text-sm tabular-nums text-gray-600">
                  {items.filter((i) => i.cleared).length} of {items.length} ticked
                </span>
              </div>
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="w-10 px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={`Tick all ${label}`}
                        disabled={!canManage || items.length === 0}
                        checked={all}
                        onChange={(e) =>
                          update(
                            e.target.checked
                              ? { clear: items.map((i) => i.txnId) }
                              : { unclear: items.map((i) => i.txnId) },
                          )
                        }
                      />
                    </th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Ref / payee</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {items.map((i) => (
                    <tr key={i.txnId} className={cx(i.cleared && 'bg-emerald-50/50')}>
                      <td className="px-3 py-1.5">
                        <input
                          type="checkbox"
                          disabled={!canManage}
                          aria-label={`Tick ${TXN_TYPE_LABELS[i.txnType] ?? i.txnType} ${i.number ?? ''} ${i.txnDate} ${i.amount}`}
                          checked={i.cleared}
                          onChange={(e) =>
                            update(e.target.checked ? { clear: [i.txnId] } : { unclear: [i.txnId] })
                          }
                        />
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5">{formatDate(i.txnDate)}</td>
                      <td className="px-3 py-1.5">
                        {TXN_TYPE_LABELS[i.txnType] ?? i.txnType}{' '}
                        {i.fromBankFeed && <Badge>Bank</Badge>}
                      </td>
                      <td className="px-3 py-1.5">
                        {[i.number, i.payee ?? i.memo].filter(Boolean).join(' · ')}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {formatMoney(
                          parseMoney(i.amount) < 0n ? -parseMoney(i.amount) : parseMoney(i.amount),
                        )}
                      </td>
                    </tr>
                  ))}
                  {items.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-gray-500">
                        None.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Card>
          );
        })}
      </div>
    </>
  );
}

export default function ReconcilePage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Reconcile />
    </Suspense>
  );
}
