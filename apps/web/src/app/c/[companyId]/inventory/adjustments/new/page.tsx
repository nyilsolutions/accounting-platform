'use client';

import { useParams, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { AdjustmentForm } from '@/components/inventory/adjustment-form';
import { useClosingPassword } from '@/components/ledger/closing-password';
import { useSalesLookups } from '@/components/sales/use-sales-lookups';
import { Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { ledgerKeys } from '@/lib/queries';

export default function NewAdjustmentFormPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const { ready, lookups } = useSalesLookups(companyId);
  const closing = useClosingPassword();
  if (!ready) return <Spinner />;
  return (
    <>
      <h2 className="mb-4 text-xl font-semibold text-gray-900">Inventory quantity adjustment</h2>
      <AdjustmentForm
        lookups={lookups}
        onSave={(input) =>
          closing.run(async (closingPassword) => {
            await api(`/companies/${companyId}/inventory/adjustments`, {
              method: 'POST',
              body: { ...input, closingPassword },
            });
            await Promise.all(
              ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })),
            );
            router.push(`/c/${companyId}/inventory`);
          })
        }
      />
      {closing.dialog}
    </>
  );
}
