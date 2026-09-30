'use client';

import { useParams } from 'next/navigation';
import { PayStub } from '@/components/payroll/pay-stub';
import { Alert, Spinner } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { usePaycheckByTransaction } from '@/lib/queries';

/** Where a paycheck transaction opens from registers and reports. */
export default function PaycheckByTransactionPage() {
  const { companyId, transactionId } = useParams<{ companyId: string; transactionId: string }>();
  const paycheck = usePaycheckByTransaction(companyId, transactionId);
  if (paycheck.isPending) return <Spinner />;
  if (!paycheck.data) return <Alert>{errorMessage(paycheck.error)}</Alert>;
  return <PayStub companyId={companyId} paycheck={paycheck.data} />;
}
