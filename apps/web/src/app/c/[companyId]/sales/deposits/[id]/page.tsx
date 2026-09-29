'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, formatMoney, type DepositDto } from '@acct/shared';
import { useClosingPassword } from '@/components/ledger/closing-password';
import { DepositForm } from '@/components/sales/deposit-form';
import { useSalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Badge, Button, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, ledgerKeys, useAccess } from '@/lib/queries';

export default function DepositPage() {
  const { companyId, id } = useParams<{ companyId: string; id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const { ready, lookups } = useSalesLookups(companyId);
  const closing = useClosingPassword();
  const [error, setError] = useState<string | null>(null);
  const deposit = useQuery({
    queryKey: keys.salesDoc(companyId, 'deposits', id),
    queryFn: () => api<DepositDto>(`/companies/${companyId}/deposits/${id}`),
  });
  if (deposit.isError) return <Alert>{errorMessage(deposit.error)}</Alert>;
  if (!ready || deposit.isPending) return <Spinner />;
  const d = deposit.data;
  const canManage = access.can('banking.manage');
  const refresh = () =>
    Promise.all(ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })));

  async function action(path: string, method: string, text: string) {
    if (!confirm(text)) return;
    setError(null);
    try {
      await closing.run(async (closingPassword) => {
        await api(`/companies/${companyId}/deposits/${id}${path}`, {
          method,
          body: { closingPassword },
        });
        await refresh();
        router.push(`/c/${companyId}/sales`);
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-gray-600">
        <Link href={`/c/${companyId}/sales`} className="text-brand-700 hover:underline">
          ← Sales
        </Link>
        <span className="font-medium text-gray-900">
          Deposit · {formatDate(d.txnDate)} · {formatMoney(d.total)}
        </span>
        {d.status === 'void' && <Badge tone="amber">Void</Badge>}
      </div>
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}
      <DepositForm
        key={d.version}
        companyId={companyId}
        initial={d}
        lookups={lookups}
        readOnly={!canManage || d.status !== 'posted'}
        onSave={(input) =>
          closing.run(async (closingPassword) => {
            await api(`/companies/${companyId}/deposits/${id}`, {
              method: 'PUT',
              body: { ...input, closingPassword },
            });
            await refresh();
            router.push(`/c/${companyId}/sales`);
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
                  onClick={() =>
                    action(
                      '/void',
                      'POST',
                      'Void this deposit? Its payments go back to Undeposited Funds.',
                    )
                  }
                >
                  Void
                </Button>
              )}
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() =>
                  action(
                    '',
                    'DELETE',
                    'Delete this deposit? Its payments go back to Undeposited Funds.',
                  )
                }
              >
                Delete
              </Button>
            </div>
          )
        }
      />
      {closing.dialog}
    </>
  );
}
