'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { formatDate, PAY_METHOD_LABELS } from '@acct/shared';
import { payDescription, Select, Table } from '@/components/payroll/payroll-ui';
import { PayrollSetupCard } from '@/components/payroll/setup-card';
import { Alert, Badge, buttonClass, Card, Spinner } from '@/components/ui';
import { useAccess, useEmployees, usePaySchedules, usePayrollSettings } from '@/lib/queries';

export default function EmployeesPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const access = useAccess(companyId);
  const settings = usePayrollSettings(companyId);
  const [status, setStatus] = useState<'active' | 'terminated' | 'all'>('active');
  const employees = useEmployees(companyId, status);
  const schedules = usePaySchedules(companyId);

  if (settings.isPending) return <Spinner />;
  if (!settings.data?.settings) return <PayrollSetupCard companyId={companyId} />;
  const scheduleName = new Map((schedules.data ?? []).map((s) => [s.id, s.name]));
  const base = `/c/${companyId}/payroll`;
  const noSchedules = schedules.isSuccess && schedules.data.length === 0;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="w-48">
          <Select
            label="Show"
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
            options={[
              { value: 'active', label: 'Active employees' },
              { value: 'terminated', label: 'Terminated' },
              { value: 'all', label: 'All employees' },
            ]}
          />
        </div>
        {access.can('payroll.manage') && !noSchedules && (
          <Link href={`${base}/employees/new`} className={buttonClass()}>
            Add employee
          </Link>
        )}
      </div>
      {noSchedules && (
        <div className="mb-4">
          <Alert kind="info">
            Add a pay schedule in{' '}
            <Link href={`${base}/setup`} className="underline">
              Setup
            </Link>{' '}
            before adding employees.
          </Alert>
        </div>
      )}
      {employees.isPending ? (
        <Spinner />
      ) : (employees.data ?? []).length === 0 ? (
        <Card className="p-6 text-sm text-gray-600">No employees to show.</Card>
      ) : (
        <Card className="p-2" data-testid="employees">
          <Table
            label="Employees"
            headers={[
              'Name',
              'Pay',
              'Schedule',
              'Works in',
              'Paid by',
              'Hired',
              'Status',
              'To complete',
            ]}
          >
            {employees.data!.map((e) => (
              <tr key={e.id}>
                <td className="px-2 py-2">
                  <Link
                    href={`${base}/employees/${e.id}`}
                    className="font-medium text-brand-700 hover:underline"
                  >
                    {e.displayName}
                  </Link>
                  {e.employeeNumber && (
                    <span className="ml-2 text-xs text-gray-500">{e.employeeNumber}</span>
                  )}
                </td>
                <td className="px-2 py-2">{payDescription(e)}</td>
                <td className="px-2 py-2">{scheduleName.get(e.payScheduleId) ?? ''}</td>
                <td className="px-2 py-2">{e.workState}</td>
                <td className="px-2 py-2">{PAY_METHOD_LABELS[e.payMethod]}</td>
                <td className="px-2 py-2">{formatDate(e.hireDate)}</td>
                <td className="px-2 py-2">
                  {e.status === 'active' ? (
                    <Badge tone="green">Active</Badge>
                  ) : (
                    <Badge>Terminated {e.terminationDate && formatDate(e.terminationDate)}</Badge>
                  )}
                </td>
                <td className="px-2 py-2 text-xs text-amber-800">{e.missing.join(', ')}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </>
  );
}
