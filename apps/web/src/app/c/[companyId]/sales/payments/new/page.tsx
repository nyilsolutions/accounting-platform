'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PaymentDto } from '@acct/shared';
import { useClosingPassword } from '@/components/ledger/closing-password';
import { PaymentForm } from '@/components/sales/payment-form';
import { useSalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { ledgerKeys } from '@/lib/queries';

function NewPayment() {
  const { companyId } = useParams<{ companyId: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const { ready, lookups } = useSalesLookups(companyId);
  const closing = useClosingPassword();
  const [saved, setSaved] = useState<string | null>(null);
  if (!ready) return <Spinner />;
  return (
    <>
      <h2 className="mb-4 text-xl font-semibold text-gray-900">Receive payment</h2>
      {saved && (
        <div className="mb-4">
          <Alert kind="success">{saved}</Alert>
        </div>
      )}
      <PaymentForm
        key={saved ?? 'new'}
        companyId={companyId}
        lookups={lookups}
        defaultCustomerId={saved ? undefined : (params.get('customerId') ?? undefined)}
        defaultInvoiceId={saved ? undefined : (params.get('invoiceId') ?? undefined)}
        onSave={(input, andNew) =>
          closing.run(async (closingPassword) => {
            const p = await api<PaymentDto>(`/companies/${companyId}/payments`, {
              method: 'POST',
              body: { ...input, closingPassword },
            });
            await Promise.all(
              ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })),
            );
            if (andNew) setSaved(`Payment of ${p.amount} from ${p.customerName} saved.`);
            else router.push(`/c/${companyId}/sales`);
          })
        }
      />
      {closing.dialog}
    </>
  );
}

export default function NewPaymentPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <NewPayment />
    </Suspense>
  );
}
