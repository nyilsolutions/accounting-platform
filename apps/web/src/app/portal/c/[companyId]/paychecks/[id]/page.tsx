'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import type { PaycheckDto } from '@acct/shared';
import { PayStubStatement } from '@/components/payroll/pay-stub';
import { portalApi, usePortalLink } from '@/components/portal/portal-context';
import { Alert, Button, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

/** One pay stub, printable. */
export default function PortalPayStubPage() {
  const link = usePortalLink();
  const { id } = useParams<{ id: string }>();
  const q = useQuery({
    queryKey: ['portal', link.companyId, 'paychecks', id],
    queryFn: () => api<PaycheckDto>(portalApi(link.companyId, `/paychecks/${id}`)),
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert>{errorMessage(q.error)}</Alert>;
  return (
    <>
      <div className="mb-4 flex items-center justify-between print:hidden">
        <Link
          href={`/portal/c/${link.companyId}/paychecks`}
          className="text-sm text-brand-700 hover:underline"
        >
          ← Pay stubs
        </Link>
        <Button variant="secondary" size="sm" onClick={() => window.print()}>
          Print or save PDF
        </Button>
      </div>
      <PayStubStatement paycheck={q.data} />
    </>
  );
}
