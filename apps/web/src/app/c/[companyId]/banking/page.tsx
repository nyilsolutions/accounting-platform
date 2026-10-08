'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { formatDollars, type BankAccountSummaryDto, type SyncResultDto } from '@acct/shared';
import {
  ConnectBankButton,
  ManageConnectionsDialog,
  useFeedConfig,
} from '@/components/banking/connect-bank';
import { FeedTable } from '@/components/banking/feed-table';
import { useBankAccounts } from '@/components/banking/use-bank-accounts';
import { useSalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Badge, Button, buttonClass, Card, cx, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { ledgerKeys, useAccess } from '@/lib/queries';

function AccountCard({
  a,
  selected,
  onSelect,
}: {
  a: BankAccountSummaryDto;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-testid="bank-account-card"
      className={cx(
        'w-64 shrink-0 rounded-lg border bg-white p-4 text-left shadow-sm',
        selected
          ? 'border-brand-600 ring-1 ring-brand-600'
          : 'border-gray-200 hover:border-gray-300',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="font-medium text-gray-900">
          {a.name}
          {a.connection?.mask && <span className="text-gray-500"> ••{a.connection.mask}</span>}
        </div>
        {a.forReviewCount > 0 && <Badge tone="amber">{a.forReviewCount}</Badge>}
      </div>
      <dl className="mt-3 space-y-1 text-sm">
        <div className="flex justify-between">
          <dt className="text-gray-500">Bank balance</dt>
          <dd className="tabular-nums">
            {a.bankBalance === null ? '—' : formatDollars(a.bankBalance)}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-gray-500">In your books</dt>
          <dd className="tabular-nums">{formatDollars(a.bookBalance)}</dd>
        </div>
      </dl>
      <div className="mt-2 text-xs text-gray-500">
        {a.connection ? (
          a.connection.status === 'error' ? (
            <span className="text-amber-700">{a.connection.institutionName}: sign in again</span>
          ) : (
            `${a.connection.institutionName}${a.connection.lastSyncedAt ? ` · updated ${new Date(a.connection.lastSyncedAt).toLocaleDateString()}` : ''}`
          )
        ) : (
          'Not connected'
        )}
        {a.lastReconciledDate && ` · reconciled through ${a.lastReconciledDate}`}
      </div>
    </button>
  );
}

function Banking() {
  const { companyId } = useParams<{ companyId: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const accounts = useBankAccounts(companyId);
  const feedConfig = useFeedConfig(companyId);
  const { ready, lookups } = useSalesLookups(companyId);
  const [manage, setManage] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [updating, setUpdating] = useState(false);
  if (accounts.isPending || !ready) return <Spinner />;
  if (accounts.isError) return <Alert>{errorMessage(accounts.error)}</Alert>;
  const list = accounts.data;
  const canManage = access.can('banking.manage');
  const selected = list.find((a) => a.accountId === params.get('account')) ?? list[0];
  const base = `/c/${companyId}/banking`;

  async function update() {
    const ids = [...new Set(list.filter((a) => a.connection).map((a) => a.connection!.id))];
    setMessage(null);
    setUpdating(true);
    try {
      let added = 0;
      for (const id of ids) {
        const r = await api<SyncResultDto>(`/companies/${companyId}/bank-connections/${id}/sync`, {
          method: 'POST',
          body: {},
        });
        added += r.added;
      }
      await Promise.all(ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })));
      setMessage({
        kind: 'success',
        text: `${added} new transaction${added === 1 ? '' : 's'} downloaded.`,
      });
    } catch (err) {
      setMessage({ kind: 'error', text: errorMessage(err) });
    } finally {
      setUpdating(false);
    }
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {canManage && <ConnectBankButton companyId={companyId} lookups={lookups} />}
        {canManage && list.some((a) => a.connection) && (
          <>
            <Button variant="secondary" onClick={update} loading={updating}>
              Update
            </Button>
            <Button variant="ghost" onClick={() => setManage(true)}>
              Manage connections
            </Button>
          </>
        )}
        {canManage && selected && (
          <Link
            href={`${base}/import?account=${selected.accountId}`}
            className={buttonClass('secondary')}
          >
            Upload transactions
          </Link>
        )}
        {feedConfig.data?.provider === 'none' && (
          <span className="text-sm text-gray-500">
            Live bank feeds aren&apos;t set up; upload statement files instead.
          </span>
        )}
      </div>
      {message && (
        <div className="mb-4">
          <Alert kind={message.kind}>{message.text}</Alert>
        </div>
      )}
      {list.length === 0 ? (
        <Card className="p-6 text-sm text-gray-600">
          Add a bank or credit card account to your chart of accounts to start banking.{' '}
          <Link href={`/c/${companyId}/accounting`} className="text-brand-700 hover:underline">
            Chart of accounts
          </Link>
        </Card>
      ) : (
        <>
          <div className="mb-5 flex gap-3 overflow-x-auto pb-1">
            {list.map((a) => (
              <AccountCard
                key={a.accountId}
                a={a}
                selected={a.accountId === selected?.accountId}
                onSelect={() => router.replace(`${base}?account=${a.accountId}`)}
              />
            ))}
          </div>
          {selected && (
            <>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold text-gray-900">{selected.name}</h2>
                <div className="flex gap-3 text-sm">
                  <Link
                    href={`${base}/register/${selected.accountId}`}
                    className="text-brand-700 hover:underline"
                  >
                    Go to register
                  </Link>
                  {canManage && (
                    <Link
                      href={`${base}/reconcile?account=${selected.accountId}`}
                      className="text-brand-700 hover:underline"
                    >
                      Reconcile
                    </Link>
                  )}
                </div>
              </div>
              <FeedTable
                key={selected.accountId}
                companyId={companyId}
                accountId={selected.accountId}
                accountType={selected.accountType}
                lookups={lookups}
                canManage={canManage}
              />
            </>
          )}
        </>
      )}
      {manage && (
        <ManageConnectionsDialog
          companyId={companyId}
          lookups={lookups}
          onClose={() => setManage(false)}
        />
      )}
    </>
  );
}

export default function BankingPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Banking />
    </Suspense>
  );
}
