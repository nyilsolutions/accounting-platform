'use client';

import { useParams, useRouter } from 'next/navigation';
import { EmployeeForm } from '@/components/payroll/employee-form';
import { Section } from '@/components/payroll/payroll-ui';

export default function NewEmployeePage() {
  const { companyId } = useParams<{ companyId: string }>();
  const router = useRouter();
  return (
    <Section
      title="New employee"
      description="Save the employee first, then add their Form W-4, state certificate and direct deposit."
    >
      <EmployeeForm
        companyId={companyId}
        onSaved={(e) => router.push(`/c/${companyId}/payroll/employees/${e.id}`)}
      />
    </Section>
  );
}
