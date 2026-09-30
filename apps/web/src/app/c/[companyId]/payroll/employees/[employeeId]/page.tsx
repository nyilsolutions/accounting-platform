'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { EmployeeForm } from '@/components/payroll/employee-form';
import {
  DirectDepositSection,
  PayItemsSection,
  PtoSection,
  StateCertificateSection,
  W4Section,
} from '@/components/payroll/employee-sections';
import { payDescription, Section } from '@/components/payroll/payroll-ui';
import { Alert, Badge, Spinner } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useEmployee } from '@/lib/queries';

export default function EmployeePage() {
  const { companyId, employeeId } = useParams<{ companyId: string; employeeId: string }>();
  const employee = useEmployee(companyId, employeeId);
  if (employee.isPending) return <Spinner />;
  if (employee.isError) return <Alert>{errorMessage(employee.error)}</Alert>;
  const e = employee.data;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link href={`/c/${companyId}/payroll`} className="text-sm text-brand-700 hover:underline">
          ← Employees
        </Link>
        <h2 className="text-xl font-semibold text-gray-900">{e.displayName}</h2>
        {e.status === 'active' ? <Badge tone="green">Active</Badge> : <Badge>Terminated</Badge>}
        <span className="text-sm text-gray-600">{payDescription(e)}</span>
      </div>
      {e.missing.length > 0 && (
        <div className="mb-4" data-testid="employee-missing">
          <Alert kind="info">To complete before the first paycheck: {e.missing.join(', ')}.</Alert>
        </div>
      )}
      <Section title="Details">
        <EmployeeForm key={e.id} companyId={companyId} employee={e} onSaved={() => undefined} />
      </Section>
      <W4Section companyId={companyId} employee={e} />
      <StateCertificateSection companyId={companyId} employee={e} />
      <DirectDepositSection companyId={companyId} employee={e} />
      <PayItemsSection companyId={companyId} employee={e} />
      <PtoSection companyId={companyId} employee={e} />
    </>
  );
}
