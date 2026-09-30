'use client';

import { useParams } from 'next/navigation';
import { PayStub } from '@/components/payroll/pay-stub';
import { Alert, Spinner } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { usePaycheck } from '@/lib/queries';

export default function PaycheckPage() {
  const { companyId, paycheckId } = useParams<{ companyId: string; paycheckId: string }>();
  const paycheck = usePaycheck(companyId, paycheckId);
  if (paycheck.isPending) return <Spinner />;
  if (!paycheck.data) return <Alert>{errorMessage(paycheck.error)}</Alert>;
  return <PayStub companyId={companyId} paycheck={paycheck.data} />;
}
