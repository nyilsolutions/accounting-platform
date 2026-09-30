'use client';

import type { FormEvent } from 'react';
import {
  DEPOSIT_SCHEDULE_LABELS,
  DEPOSIT_SCHEDULES,
  FEDERAL_FORM_LABELS,
  FEDERAL_FORMS,
} from '@acct/shared';
import { Alert, Button, Card } from '@/components/ui';
import { useAccess } from '@/lib/queries';
import { errText, formField, Select, usePayrollMutation } from './payroll-ui';

/** Shown until payroll is turned on for the company. */
export function PayrollSetupCard({ companyId }: { companyId: string }) {
  const access = useAccess(companyId);
  const m = usePayrollMutation(companyId);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await m.run('/setup', 'POST', {
      federalForm: formField(f, 'federalForm'),
      depositSchedule: formField(f, 'depositSchedule'),
    });
  }
  return (
    <Card className="max-w-2xl p-6">
      <h2 className="mb-2 text-lg font-semibold">Set up payroll</h2>
      <p className="mb-4 text-sm text-gray-600">
        Payroll uses the company&apos;s EIN and your chart&apos;s Payroll Expenses and Payroll
        Liabilities accounts. You can change the accounts, add pay schedules, states, and deductions
        afterwards. Supported states for now: California, Florida, Illinois, New York and Texas.
      </p>
      {access.can('payroll.manage') ? (
        <form onSubmit={submit} className="space-y-4">
          {m.error && <Alert>{errText(m.error)}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              label="Federal return"
              name="federalForm"
              defaultValue="941"
              options={FEDERAL_FORMS.map((v) => ({ value: v, label: FEDERAL_FORM_LABELS[v] }))}
            />
            <Select
              label="Federal deposit schedule"
              name="depositSchedule"
              defaultValue="monthly"
              hint="Set by your lookback period (IRS Pub. 15). New employers start as monthly depositors."
              options={DEPOSIT_SCHEDULES.map((v) => ({
                value: v,
                label: DEPOSIT_SCHEDULE_LABELS[v],
              }))}
            />
          </div>
          <Button type="submit" loading={m.busy}>
            Set up payroll
          </Button>
        </form>
      ) : (
        <Alert kind="info">Ask an owner, admin or payroll admin to set up payroll.</Alert>
      )}
    </Card>
  );
}
