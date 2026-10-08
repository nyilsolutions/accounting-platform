'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addDays,
  todayIso,
  type BankConnectionDto,
  type BankFeedConfigDto,
  type LinkTokenDto,
} from '@acct/shared';
import { AccountSelect } from '@/components/ledger/pickers';
import type { SalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Badge, Button, Dialog } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, ledgerKeys } from '@/lib/queries';

interface PlaidHandler {
  open: () => void;
}
declare global {
  interface Window {
    Plaid?: {
      create: (opts: {
        token: string;
        onSuccess: (
          publicToken: string,
          metadata: { institution?: { name?: string } | null },
        ) => void;
        onExit?: (err: unknown) => void;
      }) => PlaidHandler;
    };
  }
}

const PLAID_SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

function loadPlaid(): Promise<void> {
  if (window.Plaid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PLAID_SCRIPT;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load Plaid Link'));
    document.head.appendChild(s);
  });
}

/** Opens Plaid Link (or the development bank) and resolves with the public token. */
async function openLink(
  link: LinkTokenDto,
  mock: () => Promise<{ publicToken: string; institutionName?: string } | null>,
): Promise<{ publicToken: string; institutionName?: string } | null> {
  if (link.provider === 'mock') return mock();
  await loadPlaid();
  return new Promise((resolve) => {
    window
      .Plaid!.create({
        token: link.linkToken,
        onSuccess: (publicToken, metadata) =>
          resolve({ publicToken, institutionName: metadata.institution?.name ?? undefined }),
        onExit: () => resolve(null),
      })
      .open();
  });
}

export function useFeedConfig(companyId: string) {
  return useQuery({
    queryKey: [...keys.banking(companyId), 'feed-config'],
    queryFn: () => api<BankFeedConfigDto>(`/companies/${companyId}/bank-connections/config`),
    staleTime: Infinity,
  });
}

/** "Link account": connect a bank through the aggregator, then choose where each account goes. */
export function ConnectBankButton({
  companyId,
  lookups,
}: {
  companyId: string;
  lookups: SalesLookups;
}) {
  const config = useFeedConfig(companyId);
  const qc = useQueryClient();
  const [mockOpen, setMockOpen] = useState<
    ((v: { publicToken: string; institutionName?: string } | null) => void) | null
  >(null);
  const [mapping, setMapping] = useState<BankConnectionDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  if (!config.data || config.data.provider === 'none') return null;

  async function connect() {
    setError(null);
    setPending(true);
    try {
      const link = await api<LinkTokenDto>(`/companies/${companyId}/bank-connections/link-token`, {
        method: 'POST',
        body: {},
      });
      const result = await openLink(
        link,
        () => new Promise((resolve) => setMockOpen(() => resolve)),
      );
      if (!result) return;
      const connection = await api<BankConnectionDto>(`/companies/${companyId}/bank-connections`, {
        method: 'POST',
        body: result,
      });
      await qc.invalidateQueries({ queryKey: keys.banking(companyId) });
      setMapping(connection);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button variant="secondary" onClick={connect} loading={pending}>
        Link account
      </Button>
      {error && <Alert>{error}</Alert>}
      <Dialog
        open={!!mockOpen}
        onClose={() => {
          mockOpen?.(null);
          setMockOpen(null);
        }}
        title="Connect a bank (development)"
      >
        <p className="mb-4 text-sm text-gray-600">
          Bank connections run against a development bank here. With Plaid configured, this opens
          Plaid Link to sign in to a real bank.
        </p>
        <Button
          onClick={() => {
            mockOpen?.({ publicToken: 'mock-public-token', institutionName: 'First Mock Bank' });
            setMockOpen(null);
          }}
        >
          Connect First Mock Bank
        </Button>
      </Dialog>
      {mapping && (
        <MapAccountsDialog
          companyId={companyId}
          connection={mapping}
          lookups={lookups}
          onClose={() => setMapping(null)}
        />
      )}
    </>
  );
}

/** Chooses which chart account each downloaded account feeds, and from which date. */
export function MapAccountsDialog({
  companyId,
  connection,
  lookups,
  onClose,
}: {
  companyId: string;
  connection: BankConnectionDto;
  lookups: SalesLookups;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const defaultStart = addDays(todayIso(), -90);
  const [rows, setRows] = useState(
    connection.accounts.map((a) => ({
      ...a,
      accountId: a.accountId ?? '',
      startDate: a.startDate ?? defaultStart,
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save() {
    setError(null);
    setPending(true);
    try {
      await api(`/companies/${companyId}/bank-connections/${connection.id}/accounts`, {
        method: 'PUT',
        body: {
          accounts: rows.map((r) => ({
            id: r.id,
            accountId: r.accountId || null,
            startDate: r.startDate || null,
          })),
        },
      });
      await Promise.all(ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })));
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={`Connect ${connection.institutionName} accounts`} wide>
      <p className="mb-3 text-sm text-gray-600">
        Choose the account in your books each bank account feeds. Transactions from the start date
        onward are downloaded for review.
      </p>
      {error && (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      )}
      <table className="mb-4 w-full text-sm" data-testid="map-feed-accounts">
        <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="py-1">Bank account</th>
            <th className="py-1">Account in your books</th>
            <th className="py-1">From</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r, i) => (
            <tr key={r.id}>
              <td className="py-2 pr-3">
                {r.name} {r.mask && <span className="text-gray-500">••{r.mask}</span>}
              </td>
              <td className="py-2 pr-3">
                <AccountSelect
                  aria-label={`Books account for ${r.name}`}
                  accounts={lookups.accounts}
                  useNumbers={lookups.useNumbers}
                  types={
                    r.kind === 'credit_card'
                      ? ['credit_card']
                      : r.kind === 'bank'
                        ? ['bank']
                        : ['bank', 'credit_card']
                  }
                  placeholder="Don't download"
                  value={r.accountId}
                  onChange={(e) =>
                    setRows(rows.map((x, j) => (j === i ? { ...x, accountId: e.target.value } : x)))
                  }
                />
              </td>
              <td className="py-2">
                <input
                  type="date"
                  aria-label={`Download ${r.name} from`}
                  value={r.startDate}
                  onChange={(e) =>
                    setRows(rows.map((x, j) => (j === i ? { ...x, startDate: e.target.value } : x)))
                  }
                  className="rounded-md border border-gray-300 px-2 py-1"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={save} loading={pending}>
          Connect and download
        </Button>
      </div>
    </Dialog>
  );
}

/** Connected banks: re-authenticate, change account mapping, disconnect. */
export function ManageConnectionsDialog({
  companyId,
  lookups,
  onClose,
}: {
  companyId: string;
  lookups: SalesLookups;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<BankConnectionDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connections = useQuery({
    queryKey: [...keys.banking(companyId), 'connections'],
    queryFn: () => api<BankConnectionDto[]>(`/companies/${companyId}/bank-connections`),
  });
  const refresh = () =>
    Promise.all(ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })));

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function reauth(c: BankConnectionDto) {
    const link = await api<LinkTokenDto>(`/companies/${companyId}/bank-connections/link-token`, {
      method: 'POST',
      body: { connectionId: c.id },
    });
    const ok = await openLink(link, async () => ({ publicToken: 'mock-public-token' }));
    if (ok)
      await api(`/companies/${companyId}/bank-connections/${c.id}/reconnected`, {
        method: 'POST',
        body: {},
      });
  }

  if (editing)
    return (
      <MapAccountsDialog
        companyId={companyId}
        connection={editing}
        lookups={lookups}
        onClose={() => setEditing(null)}
      />
    );
  return (
    <Dialog open onClose={onClose} title="Bank connections" wide>
      {error && (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      )}
      {connections.data?.length === 0 && (
        <p className="text-sm text-gray-500">No banks are connected.</p>
      )}
      <ul className="divide-y divide-gray-100 text-sm">
        {connections.data?.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div>
              <div className="font-medium text-gray-900">
                {c.institutionName}{' '}
                {c.status === 'error' ? (
                  <Badge tone="amber">Sign-in needed</Badge>
                ) : (
                  <Badge tone="green">Connected</Badge>
                )}
              </div>
              <div className="text-xs text-gray-500">
                {c.accounts.map((a) => `${a.name}${a.mask ? ` ••${a.mask}` : ''}`).join(', ')}
                {c.lastSyncedAt && ` · Updated ${new Date(c.lastSyncedAt).toLocaleString()}`}
              </div>
              {c.errorMessage && <div className="text-xs text-amber-700">{c.errorMessage}</div>}
            </div>
            <div className="flex gap-2">
              {c.status === 'error' && (
                <Button size="sm" onClick={() => run(() => reauth(c))}>
                  Sign in again
                </Button>
              )}
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  run(() =>
                    api(`/companies/${companyId}/bank-connections/${c.id}/sync`, {
                      method: 'POST',
                      body: {},
                    }),
                  )
                }
              >
                Update
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setEditing(c)}>
                Edit accounts
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() =>
                  confirm(`Disconnect ${c.institutionName}? Downloaded transactions stay.`) &&
                  run(() =>
                    api(`/companies/${companyId}/bank-connections/${c.id}`, { method: 'DELETE' }),
                  )
                }
              >
                Disconnect
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
