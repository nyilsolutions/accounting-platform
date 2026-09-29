'use client';

import { notFound, useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SALES_DOC_BY_SLUG, type SalesDocumentDto } from '@acct/shared';
import { useClosingPassword } from '@/components/ledger/closing-password';
import { DOC_LABELS, SalesDocumentForm } from '@/components/sales/sales-document-form';
import { useSalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { ledgerKeys } from '@/lib/queries';

function NewSalesDocument() {
  const { companyId, doc } = useParams<{ companyId: string; doc: string }>();
  const type = SALES_DOC_BY_SLUG[doc];
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const { ready, lookups } = useSalesLookups(companyId);
  const closing = useClosingPassword();
  const [saved, setSaved] = useState<string | null>(null);
  const next = useQuery({
    queryKey: ['company', companyId, 'sales', doc, 'next-number', saved],
    queryFn: () => api<{ number: string }>(`/companies/${companyId}/sales/${doc}/next-number`),
    enabled: !!type,
  });
  if (!type) notFound();
  if (!ready || next.isPending) return <Spinner />;
  const labels = DOC_LABELS[type];

  return (
    <>
      <h2 className="mb-4 text-xl font-semibold text-gray-900 print:hidden">
        New {labels.title.toLowerCase()}
      </h2>
      {saved && (
        <div className="mb-4">
          <Alert kind="success">{saved} saved.</Alert>
        </div>
      )}
      <SalesDocumentForm
        key={saved ?? 'new'}
        type={type}
        lookups={lookups}
        suggestedNumber={next.data?.number}
        defaultCustomerId={params.get('customerId') ?? undefined}
        onSave={(input, action) =>
          closing.run(async (closingPassword) => {
            const created = await api<SalesDocumentDto>(`/companies/${companyId}/sales/${doc}`, {
              method: 'POST',
              body: { ...input, closingPassword },
            });
            await Promise.all(
              ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })),
            );
            if (action === 'new') setSaved(`${labels.title} ${created.number ?? ''}`.trim());
            else if (action === 'send')
              router.push(`/c/${companyId}/sales/${doc}/${created.id}?send=1`);
            else router.push(`/c/${companyId}/sales`);
          })
        }
      />
      {closing.dialog}
    </>
  );
}

export default function NewSalesDocumentPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <NewSalesDocument />
    </Suspense>
  );
}
