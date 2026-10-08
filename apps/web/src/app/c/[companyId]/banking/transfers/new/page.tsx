'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { TransferForm } from '@/components/banking/transfer-form';
import { useClosingPassword } from '@/components/ledger/closing-password';
import { useSalesLookups } from '@/components/sales/use-sales-lookups';
import { Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { ledgerKeys } from '@/lib/queries';

function NewTransfer() {
  const { companyId } = useParams<{ companyId: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const { ready, lookups } = useSalesLookups(companyId);
  const closing = useClosingPassword();
  if (!ready) return <Spinner />;
  return (
    <>
      <h2 className="mb-4 text-xl font-semibold text-gray-900">Transfer</h2>
      <TransferForm
        lookups={lookups}
        defaults={{
          fromAccountId: params.get('from') ?? undefined,
          toAccountId:
            params.get('to') ??
            (params.get('card')
              ? lookups.accounts.find((a) => a.accountType === 'credit_card' && a.isActive)?.id
              : undefined),
        }}
        onSave={(input) =>
          closing.run(async (closingPassword) => {
            await api(`/companies/${companyId}/transfers`, {
              method: 'POST',
              body: { ...input, closingPassword },
            });
            await Promise.all(
              ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })),
            );
            router.push(`/c/${companyId}/banking`);
          })
        }
      />
      {closing.dialog}
    </>
  );
}

export default function NewTransferPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <NewTransfer />
    </Suspense>
  );
}
