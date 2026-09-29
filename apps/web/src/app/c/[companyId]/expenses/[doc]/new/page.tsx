'use client';

import { notFound, useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PURCHASE_DOC_BY_SLUG, type PurchaseDocumentDto } from '@acct/shared';
import { useClosingPassword } from '@/components/ledger/closing-password';
import {
  PURCHASE_LABELS,
  PurchaseDocumentForm,
} from '@/components/purchases/purchase-document-form';
import { useSalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { ledgerKeys } from '@/lib/queries';

function NewPurchaseDocument() {
  const { companyId, doc } = useParams<{ companyId: string; doc: string }>();
  const type = PURCHASE_DOC_BY_SLUG[doc];
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const { ready, lookups } = useSalesLookups(companyId);
  const closing = useClosingPassword();
  const [saved, setSaved] = useState<string | null>(null);
  if (!type) notFound();
  if (!ready) return <Spinner />;
  const labels = PURCHASE_LABELS[type];
  return (
    <>
      <h2 className="mb-4 text-xl font-semibold text-gray-900">New {labels.title.toLowerCase()}</h2>
      {saved && (
        <div className="mb-4">
          <Alert kind="success">{saved} saved.</Alert>
        </div>
      )}
      <PurchaseDocumentForm
        key={saved ?? 'new'}
        companyId={companyId}
        type={type}
        lookups={lookups}
        defaultVendorId={params.get('vendorId') ?? undefined}
        onSave={(input, andNew) =>
          closing.run(async (closingPassword) => {
            const created = await api<PurchaseDocumentDto>(
              `/companies/${companyId}/purchases/${doc}`,
              {
                method: 'POST',
                body: { ...input, closingPassword },
              },
            );
            await Promise.all(
              ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })),
            );
            if (andNew)
              setSaved(
                `${labels.title}${created.number ? ` ${created.number}` : ''} (${created.total})`,
              );
            else router.push(`/c/${companyId}/expenses`);
          })
        }
      />
      {closing.dialog}
    </>
  );
}

export default function NewPurchaseDocumentPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <NewPurchaseDocument />
    </Suspense>
  );
}
