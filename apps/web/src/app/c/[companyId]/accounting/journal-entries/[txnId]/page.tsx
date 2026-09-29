'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, todayIso, type JournalEntryDto } from '@acct/shared';
import { useClosingPassword } from '@/components/ledger/closing-password';
import { JournalEntryForm } from '@/components/ledger/journal-entry-form';
import { useJournalLookups } from '@/components/ledger/use-journal-lookups';
import { Alert, Badge, Button, Dialog, Spinner, TextInput } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, ledgerKeys, useAccess } from '@/lib/queries';
import { Attachments } from '@/components/documents/attachments';

export default function JournalEntryPage() {
  const { companyId, txnId } = useParams<{ companyId: string; txnId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const { ready, lookups } = useJournalLookups(companyId);
  const closing = useClosingPassword();
  const [error, setError] = useState<string | null>(null);
  const [reversing, setReversing] = useState(false);
  const entry = useQuery({
    queryKey: keys.journalEntry(companyId, txnId),
    queryFn: () => api<JournalEntryDto>(`/companies/${companyId}/journal-entries/${txnId}`),
  });

  if (entry.isError) return <Alert>{errorMessage(entry.error)}</Alert>;
  if (!ready || entry.isPending) return <Spinner />;
  const je = entry.data;
  const canManage = access.can('ledger.manage');
  const listUrl = `/c/${companyId}/accounting/journal-entries`;

  const refresh = () =>
    Promise.all(ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })));

  async function action(path: string, method: string, body?: object) {
    setError(null);
    try {
      await closing.run(async (closingPassword) => {
        await api(`/companies/${companyId}/journal-entries/${txnId}${path}`, {
          method,
          body: { ...body, closingPassword },
        });
        await refresh();
        router.push(listUrl);
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-gray-600">
        <Link href={listUrl} className="text-brand-700 hover:underline">
          ← Journal entries
        </Link>
        <span>
          Journal entry {je.number ? `#${je.number}` : ''} · {formatDate(je.txnDate)}
        </span>
        {je.status === 'void' && <Badge tone="amber">Void</Badge>}
        {je.reversalOfId && (
          <Link
            href={`/c/${companyId}/accounting/journal-entries/${je.reversalOfId}`}
            className="text-brand-700 hover:underline"
          >
            Reverses another entry
          </Link>
        )}
        <span className="text-xs text-gray-400">Version {je.version}</span>
      </div>
      {je.status === 'void' && (
        <div className="mb-4">
          <Alert kind="info">
            This entry is void. It is kept for your records but does not affect any balances or
            reports.
          </Alert>
        </div>
      )}
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}
      <JournalEntryForm
        key={je.version}
        initial={je}
        lookups={lookups}
        readOnly={!canManage || je.status !== 'posted'}
        onSave={(input, andNew) =>
          closing.run(async (closingPassword) => {
            await api(`/companies/${companyId}/journal-entries/${txnId}`, {
              method: 'PUT',
              body: { ...input, closingPassword },
            });
            await refresh();
            router.push(andNew ? `${listUrl}/new` : listUrl);
          })
        }
        footer={
          canManage && (
            <div className="flex flex-wrap gap-2">
              {je.status === 'posted' && (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setReversing(true)}
                  >
                    Reverse
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      confirm(
                        'Void this journal entry? It will stay on record with no effect on balances.',
                      ) && action('/void', 'POST')
                    }
                  >
                    Void
                  </Button>
                </>
              )}
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() =>
                  confirm(
                    'Delete this journal entry? It will be removed from all lists and reports.',
                  ) && action('', 'DELETE')
                }
              >
                Delete
              </Button>
              <Link
                href={`/c/${companyId}/settings/audit-log?entity=${txnId}`}
                className="self-center text-xs text-gray-500 hover:underline"
              >
                History
              </Link>
            </div>
          )
        }
      />
      <Dialog open={reversing} onClose={() => setReversing(false)} title="Reverse journal entry">
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const txnDate = String(new FormData(e.currentTarget).get('txnDate'));
            setError(null);
            try {
              await closing.run(async (closingPassword) => {
                const rev = await api<JournalEntryDto>(
                  `/companies/${companyId}/journal-entries/${txnId}/reverse`,
                  {
                    method: 'POST',
                    body: { txnDate, closingPassword },
                  },
                );
                await refresh();
                setReversing(false);
                router.push(`${listUrl}/${rev.id}`);
              });
            } catch (err) {
              setError(errorMessage(err));
              setReversing(false);
            }
          }}
        >
          <p className="text-sm text-gray-700">
            Creates a new entry with the debits and credits swapped, typically dated the first day
            of the next period.
          </p>
          <TextInput
            label="Reversal date"
            name="txnDate"
            type="date"
            defaultValue={todayIso()}
            required
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setReversing(false)}>
              Cancel
            </Button>
            <Button type="submit">Create reversing entry</Button>
          </div>
        </form>
      </Dialog>
      <Attachments companyId={companyId} entityType="transaction" entityId={txnId} />
      {closing.dialog}
    </>
  );
}
