'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, type InventoryAdjustmentDto } from '@acct/shared';
import { Attachments } from '@/components/documents/attachments';
import { AdjustmentForm } from '@/components/inventory/adjustment-form';
import { useClosingPassword } from '@/components/ledger/closing-password';
import { useSalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Badge, Button, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, ledgerKeys, useAccess } from '@/lib/queries';

export default function AdjustmentFormPage() {
  const { companyId, id } = useParams<{ companyId: string; id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const { ready, lookups } = useSalesLookups(companyId);
  const closing = useClosingPassword();
  const [error, setError] = useState<string | null>(null);
  const doc = useQuery({
    queryKey: [...keys.inventory(companyId), 'adjustments', id],
    queryFn: () =>
      api<InventoryAdjustmentDto>(`/companies/${companyId}/inventory/adjustments/${id}`),
  });
  if (doc.isError) return <Alert>{errorMessage(doc.error)}</Alert>;
  if (!ready || doc.isPending) return <Spinner />;
  const d = doc.data;
  const canManage = access.can('inventory.manage');
  const done = async () => {
    await Promise.all(ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })));
    router.push(`/c/${companyId}/inventory`);
  };

  async function action(path: string, method: string, text: string) {
    if (!confirm(text)) return;
    setError(null);
    try {
      await closing.run(async (closingPassword) => {
        await api(`/companies/${companyId}/inventory/adjustments/${id}${path}`, {
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
          Inventory quantity adjustment · {formatDate(d.txnDate)}
          {d.number ? ` · No. ${d.number}` : ''}
        </span>
        {d.status === 'void' && <Badge tone="amber">Void</Badge>}
      </div>
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}
      <AdjustmentForm
        key={d.version}
        initial={d}
        lookups={lookups}
        readOnly={!canManage || d.status !== 'posted'}
        onSave={(input) =>
          closing.run(async (closingPassword) => {
            await api(`/companies/${companyId}/inventory/adjustments/${id}`, {
              method: 'PUT',
              body: { ...input, closingPassword },
            });
            await done();
          })
        }
        footer={
          canManage && (
            <div className="flex gap-2">
              {d.status === 'posted' && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => action('/void', 'POST', 'Void this adjustment?')}
                >
                  Void
                </Button>
              )}
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() => action('', 'DELETE', 'Delete this adjustment?')}
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
