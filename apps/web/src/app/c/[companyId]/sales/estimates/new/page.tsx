'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EstimateDto } from '@acct/shared';
import { EstimateForm } from '@/components/sales/estimate-form';
import { useSalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';

function NewEstimate() {
  const { companyId } = useParams<{ companyId: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const { ready, lookups } = useSalesLookups(companyId);
  const [saved, setSaved] = useState<string | null>(null);
  const next = useQuery({
    queryKey: [...keys.sales(companyId), 'estimates', 'next-number', saved],
    queryFn: () => api<{ number: string }>(`/companies/${companyId}/estimates/next-number`),
  });
  if (!ready || next.isPending) return <Spinner />;
  return (
    <>
      <h2 className="mb-4 text-xl font-semibold text-gray-900">New estimate</h2>
      {saved && (
        <div className="mb-4">
          <Alert kind="success">Estimate {saved} saved.</Alert>
        </div>
      )}
      <EstimateForm
        key={saved ?? 'new'}
        lookups={lookups}
        suggestedNumber={next.data?.number}
        defaultCustomerId={params.get('customerId') ?? undefined}
        onSave={async (input, andNew) => {
          const e = await api<EstimateDto>(`/companies/${companyId}/estimates`, {
            method: 'POST',
            body: input,
          });
          await qc.invalidateQueries({ queryKey: keys.sales(companyId) });
          if (andNew) setSaved(e.number ?? '');
          else router.push(`/c/${companyId}/sales/estimates`);
        }}
      />
    </>
  );
}

export default function NewEstimatePage() {
  return (
    <Suspense fallback={<Spinner />}>
      <NewEstimate />
    </Suspense>
  );
}
