'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import {
  PAY_METHOD_LABELS,
  PAY_METHODS,
  PAY_TYPE_LABELS,
  PAY_TYPES,
  PAYROLL_STATE_LABELS,
  PAYROLL_STATES,
  US_STATES,
  type EmployeeDto,
  type PayType,
} from '@acct/shared';
import { Alert, Button, Spinner, TextInput } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAccess, usePayrollLookups, usePaySchedules, useWorkersComp } from '@/lib/queries';
import { Checkbox, errText, formField, Select, usePayrollMutation } from './payroll-ui';

function Fieldset({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="rounded-md border border-gray-200 p-4">
      <legend className="px-1 text-sm font-medium text-gray-800">{legend}</legend>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </fieldset>
  );
}

/** Personal, address and job details. Creates the employee, or saves changes to one. */
export function EmployeeForm({
  companyId,
  employee,
  onSaved,
}: {
  companyId: string;
  employee?: EmployeeDto;
  onSaved: (e: EmployeeDto) => void;
}) {
  const access = useAccess(companyId);
  const schedules = usePaySchedules(companyId);
  const lookups = usePayrollLookups(companyId);
  const workersComp = useWorkersComp(companyId);
  const m = usePayrollMutation(companyId);
  const [payType, setPayType] = useState<PayType>(employee?.payType ?? 'hourly');
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const canManage = access.can('payroll.manage');
  const e = employee;

  async function reveal() {
    try {
      const r = await api<{ ssn: string | null }>(
        `/companies/${companyId}/payroll/employees/${e!.id}/reveal-ssn`,
        { method: 'POST' },
      );
      setRevealed(r.ssn);
    } catch (err) {
      setRevealError(errorMessage(err));
    }
  }

  async function submit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    const text = (k: string) => formField(f, k);
    const ssn = text('ssn');
    const body = {
      employeeNumber: text('employeeNumber'),
      firstName: text('firstName'),
      middleName: text('middleName'),
      lastName: text('lastName'),
      suffix: text('suffix'),
      ...(ssn ? { ssn } : {}),
      dateOfBirth: text('dateOfBirth'),
      email: text('email'),
      phone: text('phone'),
      addressLine1: text('addressLine1'),
      addressLine2: text('addressLine2'),
      city: text('city'),
      state: text('state'),
      postalCode: text('postalCode'),
      workAddressLine1: text('workAddressLine1'),
      workCity: text('workCity'),
      workState: text('workState'),
      workPostalCode: text('workPostalCode'),
      hireDate: text('hireDate'),
      terminationDate: text('terminationDate'),
      terminationReason: text('terminationReason'),
      payType,
      payRate: payType === 'commission' ? '' : text('payRate'),
      defaultHours: text('defaultHours'),
      payScheduleId: text('payScheduleId'),
      payMethod: text('payMethod'),
      overtimeExempt: f.get('overtimeExempt') === 'on',
      nyDblExempt: f.get('nyDblExempt') === 'on',
      tippedOccupationCodes: formField(f, 'tippedOccupationCodes'),
      workersCompClassId: text('workersCompClassId') || null,
      classId: text('classId') || null,
      locationId: text('locationId') || null,
      notes: text('notes'),
    };
    const saved = await m.run<EmployeeDto>(
      e ? `/employees/${e.id}` : '/employees',
      e ? 'PUT' : 'POST',
      body,
    );
    if (saved) onSaved(saved);
  }

  // Uncontrolled selects need their options before the first render (see the setup page).
  if (schedules.isPending || lookups.isPending || workersComp.isPending) return <Spinner />;

  const err = m.fieldError;
  return (
    <form onSubmit={submit} className="space-y-5" aria-label="Employee details">
      {m.error && <Alert>{errText(m.error)}</Alert>}
      <fieldset disabled={!canManage} className="space-y-5">
        <Fieldset legend="Personal">
          <TextInput
            label="First name"
            name="firstName"
            defaultValue={e?.firstName ?? ''}
            error={err('firstName')}
            required
          />
          <TextInput label="Middle name" name="middleName" defaultValue={e?.middleName ?? ''} />
          <TextInput
            label="Last name"
            name="lastName"
            defaultValue={e?.lastName ?? ''}
            error={err('lastName')}
            required
          />
          <TextInput label="Suffix" name="suffix" defaultValue={e?.suffix ?? ''} />
          <TextInput
            label="Employee ID"
            name="employeeNumber"
            defaultValue={e?.employeeNumber ?? ''}
            error={err('employeeNumber')}
          />
          <div>
            <TextInput
              label="Social Security number"
              name="ssn"
              autoComplete="off"
              placeholder={revealed ?? e?.ssnMasked ?? 'NNN-NN-NNNN'}
              hint={
                e?.ssnMasked ? 'Stored encrypted. Leave blank to keep it.' : 'Stored encrypted.'
              }
              error={err('ssn')}
            />
            {e?.ssnMasked && access.can('payroll.sensitive.reveal') && !revealed && (
              <button
                type="button"
                className="mt-1 text-xs text-brand-700 underline"
                onClick={reveal}
              >
                Show SSN (logged)
              </button>
            )}
            {revealError && <p className="text-xs text-red-600">{revealError}</p>}
          </div>
          <TextInput
            label="Date of birth"
            name="dateOfBirth"
            type="date"
            defaultValue={e?.dateOfBirth ?? ''}
            error={err('dateOfBirth')}
          />
          <TextInput
            label="Email"
            name="email"
            type="email"
            defaultValue={e?.email ?? ''}
            error={err('email')}
          />
          <TextInput label="Phone" name="phone" defaultValue={e?.phone ?? ''} />
        </Fieldset>

        <Fieldset legend="Home address">
          <TextInput label="Street" name="addressLine1" defaultValue={e?.addressLine1 ?? ''} />
          <TextInput label="Apt, suite" name="addressLine2" defaultValue={e?.addressLine2 ?? ''} />
          <TextInput label="City" name="city" defaultValue={e?.city ?? ''} />
          <Select
            label="State"
            name="state"
            defaultValue={e?.state ?? ''}
            placeholder="—"
            options={US_STATES.map((s) => ({ value: s, label: s }))}
            error={err('state')}
          />
          <TextInput
            label="ZIP code"
            name="postalCode"
            defaultValue={e?.postalCode ?? ''}
            error={err('postalCode')}
          />
        </Fieldset>

        <Fieldset legend="Work location">
          <TextInput
            label="Work street"
            name="workAddressLine1"
            defaultValue={e?.workAddressLine1 ?? ''}
          />
          <TextInput label="Work city" name="workCity" defaultValue={e?.workCity ?? ''} />
          <Select
            label="Work state"
            name="workState"
            defaultValue={e?.workState ?? ''}
            placeholder="Choose a state"
            options={PAYROLL_STATES.map((s) => ({ value: s, label: PAYROLL_STATE_LABELS[s] }))}
            error={err('workState')}
            required
          />
          <TextInput
            label="Work ZIP code"
            name="workPostalCode"
            defaultValue={e?.workPostalCode ?? ''}
            error={err('workPostalCode')}
          />
        </Fieldset>

        <Fieldset legend="Job and pay">
          <TextInput
            label="Hire date"
            name="hireDate"
            type="date"
            defaultValue={e?.hireDate ?? ''}
            error={err('hireDate')}
            required
          />
          <TextInput
            label="Last day worked"
            name="terminationDate"
            type="date"
            defaultValue={e?.terminationDate ?? ''}
            error={err('terminationDate')}
          />
          <TextInput
            label="Reason for leaving"
            name="terminationReason"
            defaultValue={e?.terminationReason ?? ''}
          />
          <Select
            label="Pay type"
            name="payType"
            value={payType}
            onChange={(ev) => setPayType(ev.target.value as PayType)}
            options={PAY_TYPES.map((t) => ({ value: t, label: PAY_TYPE_LABELS[t] }))}
          />
          {payType !== 'commission' && (
            <TextInput
              key={payType}
              label={payType === 'hourly' ? 'Hourly rate' : 'Annual salary'}
              name="payRate"
              inputMode="decimal"
              defaultValue={e && e.payType === payType ? e.payRate : ''}
              error={err('payRate')}
            />
          )}
          <TextInput
            label={
              payType === 'hourly' ? 'Usual hours per paycheck' : 'Hours per paycheck (for PTO)'
            }
            name="defaultHours"
            inputMode="decimal"
            defaultValue={e?.defaultHours ?? ''}
            error={err('defaultHours')}
          />
          <Select
            label="Pay schedule"
            name="payScheduleId"
            defaultValue={e?.payScheduleId ?? schedules.data?.find((s) => s.isActive)?.id ?? ''}
            placeholder="Choose a schedule"
            options={(schedules.data ?? [])
              .filter((s) => s.isActive || s.id === e?.payScheduleId)
              .map((s) => ({ value: s.id, label: s.name }))}
            error={err('payScheduleId')}
            required
          />
          <Select
            label="Pay method"
            name="payMethod"
            defaultValue={e?.payMethod ?? 'check'}
            options={PAY_METHODS.map((p) => ({ value: p, label: PAY_METHOD_LABELS[p] }))}
          />
          <Select
            label="Workers' comp class"
            name="workersCompClassId"
            defaultValue={e?.workersCompClassId ?? ''}
            placeholder="None"
            options={(workersComp.data ?? [])
              .filter((w) => w.isActive || w.id === e?.workersCompClassId)
              .map((w) => ({ value: w.id, label: `${w.state} ${w.code} ${w.description}` }))}
          />
          {(lookups.data?.classes.length ?? 0) > 0 && (
            <Select
              label="Class"
              name="classId"
              defaultValue={e?.classId ?? ''}
              placeholder="None"
              options={lookups.data!.classes.map((c) => ({ value: c.id, label: c.fullName }))}
            />
          )}
          {(lookups.data?.locations.length ?? 0) > 0 && (
            <Select
              label="Location"
              name="locationId"
              defaultValue={e?.locationId ?? ''}
              placeholder="None"
              options={lookups.data!.locations.map((c) => ({ value: c.id, label: c.fullName }))}
            />
          )}
          <div className="flex items-end pb-2">
            <Checkbox
              label="Exempt from overtime"
              name="overtimeExempt"
              defaultChecked={e?.overtimeExempt ?? false}
            />
          </div>
          <TextInput
            label="Tipped occupation code(s)"
            name="tippedOccupationCodes"
            defaultValue={e?.tippedOccupationCodes ?? ''}
            hint="For W-2 box 14b when the employee reports tips. From IRS.gov/TippedOccupations."
            error={err('tippedOccupationCodes')}
          />
          <div className="flex items-end pb-2">
            <Checkbox
              label="New York: no DBL contribution (Form DB-130 filed)"
              name="nyDblExempt"
              defaultChecked={e?.nyDblExempt ?? false}
            />
          </div>
        </Fieldset>
        <TextInput label="Notes" name="notes" defaultValue={e?.notes ?? ''} />
      </fieldset>
      {canManage && (
        <div className="flex justify-end">
          <Button type="submit" loading={m.busy}>
            {e ? 'Save changes' : 'Save employee'}
          </Button>
        </div>
      )}
    </form>
  );
}
