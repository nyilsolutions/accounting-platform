'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, formatMoney, type TransferDto } from '@acct/shared';
import { TransferForm } from '@/components/banking/transfer-form';
import { useClosingPassword } from '@/components/ledger/closing-password';
import { useSalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Badge, Button, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, ledgerKeys, useAccess } from '@/lib/queries';
import { Attachments } from '@/components/documents/attachments';

export default function TransferPage() {
  const { companyId, id } = useParams<{ companyId: string; id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const { ready, lookups } = useSalesLookups(companyId);
  const closing = useClosingPassword();
  const [error, setError] = useState<string | null>(null);
  const transfer = useQuery({
    queryKey: [...keys.banking(companyId), 'transfer', id],
    queryFn: () => api<TransferDto>(`/companies/${companyId}/transfers/${id}`),
  });
  if (transfer.isError) return <Alert>{errorMessage(transfer.error)}</Alert>;
  if (!ready || transfer.isPending) return <Spinner />;
  const t = transfer.data;
  const canManage = access.can('banking.manage');
  const done = async () => {
    await Promise.all(ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })));
    router.push(`/c/${companyId}/banking`);
  };

  async function action(path: string, method: string, text: string) {
    if (!confirm(text)) return;
    setError(null);
    try {
      await closing.run(async (closingPassword) => {
        await api(`/companies/${companyId}/transfers/${id}${path}`, {
          method,
          body: { closingPassword },
        });
        await done();
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium text-gray-900">
          Transfer · {formatDate(t.txnDate)} · {formatMoney(t.amount)}
        </span>
        {t.status === 'void' && <Badge tone="amber">Void</Badge>}
      </div>
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}
      <TransferForm
        key={t.version}
        initial={t}
        lookups={lookups}
        readOnly={!canManage || t.status !== 'posted'}
        onSave={(input) =>
          closing.run(async (closingPassword) => {
            await api(`/companies/${companyId}/transfers/${id}`, {
              method: 'PUT',
              body: { ...input, closingPassword },
            });
            await done();
          })
        }
        footer={
          canManage && (
            <div className="flex gap-2">
              {t.status === 'posted' && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => action('/void', 'POST', 'Void this transfer?')}
                >
                  Void
                </Button>
              )}
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() => action('', 'DELETE', 'Delete this transfer?')}
              >
                Delete
              </Button>
            </div>
          )
        }
      />
      <Attachments companyId={companyId} entityType="transaction" entityId={id} />
      {closing.dialog}
    </>
  );
}
