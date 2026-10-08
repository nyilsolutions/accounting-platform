'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  PAY_FREQUENCIES,
  PAY_FREQUENCY_LABELS,
  PAY_RUN_KIND_LABELS,
  formatDate,
  todayIso,
  type PayRunDto,
  type PayRunKind,
} from '@acct/shared';
import {
  Checkbox,
  dollars,
  errText,
  formField,
  Section,
  Select,
  Table,
  usePayrollMutation,
} from '@/components/payroll/payroll-ui';
import { RUN_STATUS } from '@/components/payroll/pay-run-ui';
import { PayrollSetupCard } from '@/components/payroll/setup-card';
import { Alert, Badge, Button, Spinner, TextInput } from '@/components/ui';
import {
  useAccess,
  useEmployees,
  usePayRuns,
  usePaySchedules,
  usePayrollSettings,
} from '@/lib/queries';

export default function PayRunsPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const router = useRouter();
  const access = useAccess(companyId);
  const settings = usePayrollSettings(companyId);
  const runs = usePayRuns(companyId);
  const schedules = usePaySchedules(companyId);
  const employees = useEmployees(companyId, 'all');
  const m = usePayrollMutation(companyId);
  const [kind, setKind] = useState<PayRunKind>('regular');
  const [chosen, setChosen] = useState<string[]>([]);

  if (settings.isPending || runs.isPending) return <Spinner />;
  if (!settings.data?.settings) return <PayrollSetupCard companyId={companyId} />;
  const activeSchedules = (schedules.data ?? []).filter((s) => s.isActive);

  async function start(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body =
      kind === 'regular'
        ? {
            kind,
            payScheduleId: formField(f, 'payScheduleId'),
            payDate: formField(f, 'payDate') || undefined,
          }
        : {
            kind,
            payDate: formField(f, 'payDate'),
            frequency: formField(f, 'frequency'),
            employeeIds: chosen,
          };
    const run = await m.run<PayRunDto>('/pay-runs', 'POST', body);
    if (run) router.push(`/c/${companyId}/payroll/runs/${run.id}`);
  }

  return (
    <>
      {access.can('payroll.manage') && (
        <Section
          title="Run payroll"
          description="A regular run pays the next period of a pay schedule. Off-cycle, bonus and final runs pay the employees you choose."
          testId="start-run"
        >
          {m.error && (
            <div className="mb-3">
              <Alert>{errText(m.error)}</Alert>
            </div>
          )}
          <form onSubmit={start} className="grid gap-4 sm:grid-cols-3" aria-label="Run payroll">
            <Select
              label="Kind of run"
              value={kind}
              onChange={(e) => setKind(e.target.value as PayRunKind)}
              options={Object.entries(PAY_RUN_KIND_LABELS).map(([value, label]) => ({
                value,
                label,
              }))}
            />
            {kind === 'regular' ? (
              <>
                <Select
                  label="Pay schedule"
                  name="payScheduleId"
                  options={activeSchedules.map((s) => ({ value: s.id, label: s.name }))}
                  placeholder={activeSchedules.length ? undefined : 'Add a pay schedule in Setup'}
                  error={m.fieldError('payScheduleId')}
                />
                <TextInput
                  label="Pay date (optional)"
                  name="payDate"
                  type="date"
                  hint="Leave empty for the schedule's pay date."
                />
              </>
            ) : (
              <>
                <TextInput
                  label="Pay date"
                  name="payDate"
                  type="date"
                  defaultValue={todayIso()}
                  error={m.fieldError('payDate')}
                />
                <Select
                  label="Withhold as if paid"
                  name="frequency"
                  hint="The pay frequency used to figure withholding."
                  options={PAY_FREQUENCIES.map((f) => ({
                    value: f,
                    label: PAY_FREQUENCY_LABELS[f],
                  }))}
                  defaultValue="biweekly"
                />
                <fieldset className="sm:col-span-3">
                  <legend className="mb-2 text-sm font-medium text-gray-700">Employees</legend>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {(employees.data ?? []).map((e) => (
                      <Checkbox
                        key={e.id}
                        label={`${e.displayName}${e.status === 'terminated' ? ' (terminated)' : ''}`}
                        checked={chosen.includes(e.id)}
                        onChange={(on) =>
                          setChosen((c) => (on ? [...c, e.id] : c.filter((x) => x !== e.id)))
                        }
                      />
                    ))}
                  </div>
                  {m.fieldError('employeeIds') && (
                    <p className="mt-1 text-xs text-red-600">{m.fieldError('employeeIds')}</p>
                  )}
                </fieldset>
              </>
            )}
            <div className="sm:col-span-3">
              <Button type="submit" loading={m.busy}>
                Start pay run
              </Button>
            </div>
          </form>
        </Section>
      )}
      <Section title="Pay runs" testId="pay-runs">
        {(runs.data ?? []).length === 0 ? (
          <p className="text-sm text-gray-600">No pay runs yet.</p>
        ) : (
          <Table
            label="Pay runs"
            headers={[
              'Pay date',
              'Run',
              'Period',
              'Paychecks',
              'Gross pay',
              'Net pay',
              'Total cost',
              'Status',
            ]}
          >
            {runs.data!.map((r) => (
              <tr key={r.id}>
                <td className="px-2 py-2">
                  <Link
                    className="text-brand-700 hover:underline"
                    href={`/c/${companyId}/payroll/runs/${r.id}`}
                  >
                    {formatDate(r.payDate)}
                  </Link>
                </td>
                <td className="px-2 py-2">
                  {PAY_RUN_KIND_LABELS[r.kind]}
                  {r.payScheduleName ? ` · ${r.payScheduleName}` : ''}
                </td>
                <td className="px-2 py-2">
                  {r.periodStart
                    ? `${formatDate(r.periodStart)} – ${formatDate(r.periodEnd!)}`
                    : '—'}
                </td>
                <td className="px-2 py-2">{r.paycheckCount}</td>
                <td className="px-2 py-2">{dollars(r.grossPay)}</td>
                <td className="px-2 py-2">{dollars(r.netPay)}</td>
                <td className="px-2 py-2">{dollars(r.totalCost)}</td>
                <td className="px-2 py-2">
                  <Badge tone={RUN_STATUS[r.status].tone}>{RUN_STATUS[r.status].label}</Badge>
                  {r.problemCount > 0 && (
                    <span className="ml-2 text-xs text-red-700">{r.problemCount} to fix</span>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </>
  );
}
