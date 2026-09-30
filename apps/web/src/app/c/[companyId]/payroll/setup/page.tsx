'use client';

import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  DEPOSIT_SCHEDULE_LABELS,
  DEPOSIT_SCHEDULES,
  FEDERAL_FORM_LABELS,
  FEDERAL_FORMS,
  formatDate,
  GARNISHMENT_TYPE_LABELS,
  GARNISHMENT_TYPES,
  PAY_FREQUENCIES,
  PAY_FREQUENCY_LABELS,
  PAYROLL_ITEM_CATEGORIES,
  PAYROLL_ITEM_CATEGORY_LABELS,
  PAYROLL_ITEM_KIND_LIST,
  PAYROLL_ITEM_KINDS,
  PAYROLL_STATE_LABELS,
  PAYROLL_STATES,
  payrollItemCategory,
  PTO_ACCRUAL_LABELS,
  PTO_ACCRUAL_METHODS,
  PTO_KIND_LABELS,
  PTO_KINDS,
  type PayrollItemDto,
  type PayrollItemKind,
  type PayrollSettingsDto,
  type PayScheduleDto,
  type PtoPolicyDto,
  type StateRegistrationDto,
  type WorkersCompClassDto,
} from '@acct/shared';
import {
  accountOptions,
  Checkbox,
  errText,
  formField,
  Section,
  Select,
  Table,
  usePayrollMutation,
} from '@/components/payroll/payroll-ui';
import { PayrollSetupCard } from '@/components/payroll/setup-card';
import { Alert, Badge, Button, Dialog, Spinner, TextInput } from '@/components/ui';
import {
  useAccess,
  usePayrollItems,
  usePayrollLookups,
  usePayrollSettings,
  usePayrollStates,
  usePaySchedules,
  usePtoPolicies,
  useWorkersComp,
} from '@/lib/queries';

type DialogState =
  | { kind: 'schedule'; value?: PayScheduleDto }
  | { kind: 'state'; value?: StateRegistrationDto }
  | { kind: 'rate'; value: StateRegistrationDto }
  | { kind: 'workers-comp'; value?: WorkersCompClassDto }
  | { kind: 'pto'; value?: PtoPolicyDto }
  | { kind: 'item'; value?: PayrollItemDto };

function dialogTitle(d: DialogState): string {
  switch (d.kind) {
    case 'schedule':
      return d.value ? 'Edit pay schedule' : 'Add pay schedule';
    case 'state':
      return d.value ? `Edit ${PAYROLL_STATE_LABELS[d.value.state]}` : 'Add state';
    case 'rate':
      return `Set ${PAYROLL_STATE_LABELS[d.value.state]} unemployment rate`;
    case 'workers-comp':
      return d.value ? "Edit workers' comp class" : "Add workers' comp class";
    case 'pto':
      return d.value ? 'Edit PTO policy' : 'Add PTO policy';
    case 'item':
      return d.value ? 'Edit payroll item' : 'Add payroll item';
  }
}

export default function PayrollSetupPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const settings = usePayrollSettings(companyId);
  if (settings.isPending) return <Spinner />;
  if (!settings.data?.settings) return <PayrollSetupCard companyId={companyId} />;
  return <Setup companyId={companyId} settings={settings.data.settings} />;
}

function Setup({ companyId, settings }: { companyId: string; settings: PayrollSettingsDto }) {
  const canManage = useAccess(companyId).can('payroll.manage');
  const lookups = usePayrollLookups(companyId);
  const schedules = usePaySchedules(companyId);
  const states = usePayrollStates(companyId);
  const workersComp = useWorkersComp(companyId);
  const pto = usePtoPolicies(companyId);
  const items = usePayrollItems(companyId);
  const m = usePayrollMutation(companyId);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [saved, setSaved] = useState(false);
  const [itemKind, setItemKind] = useState<PayrollItemKind>('bonus');
  const open = (d: DialogState) => {
    m.setError(null);
    setDialog(d);
  };
  const accountName = (id: string | null) =>
    lookups.data?.accounts.find((a) => a.id === id)?.fullName ?? '';

  async function saveSettings(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaved(false);
    const f = new FormData(e.currentTarget);
    const t = (k: string) => formField(f, k);
    const result = await m.run('/settings', 'PUT', {
      federalForm: t('federalForm'),
      depositSchedule: t('depositSchedule'),
      payrollStartDate: t('payrollStartDate'),
      wageExpenseAccountId: t('wageExpenseAccountId'),
      taxExpenseAccountId: t('taxExpenseAccountId'),
      liabilityAccountId: t('liabilityAccountId'),
      bankAccountId: t('bankAccountId') || null,
      achOdfiRouting: t('achOdfiRouting'),
      achOdfiName: t('achOdfiName'),
      achCompanyName: t('achCompanyName'),
      achCompanyId: t('achCompanyId'),
    });
    if (result) setSaved(true);
  }

  async function submitDialog(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!dialog) return;
    const f = new FormData(e.currentTarget);
    const t = (k: string) => formField(f, k);
    const active = f.get('isActive') === 'on';
    let ok: unknown;
    switch (dialog.kind) {
      case 'schedule':
        ok = await m.run(
          dialog.value ? `/schedules/${dialog.value.id}` : '/schedules',
          dialog.value ? 'PUT' : 'POST',
          {
            name: t('name'),
            frequency: t('frequency'),
            firstPeriodEnd: t('firstPeriodEnd'),
            payDateOffset: Number(t('payDateOffset') || 0),
            ...(dialog.value ? { isActive: active } : {}),
          },
        );
        break;
      case 'state':
        ok = await m.run(
          dialog.value ? `/states/${dialog.value.id}` : '/states',
          dialog.value ? 'PUT' : 'POST',
          {
            state: dialog.value?.state ?? t('state'),
            withholdingAccountNumber: t('withholdingAccountNumber'),
            unemploymentAccountNumber: t('unemploymentAccountNumber'),
            withholdingDepositSchedule: t('withholdingDepositSchedule') || null,
          },
        );
        break;
      case 'rate':
        ok = await m.run(`/states/${dialog.value.id}/unemployment-rates`, 'PUT', {
          year: Number(t('year')),
          rate: t('rate'),
        });
        break;
      case 'workers-comp':
        ok = await m.run(
          dialog.value ? `/workers-comp/${dialog.value.id}` : '/workers-comp',
          dialog.value ? 'PUT' : 'POST',
          {
            state: t('state'),
            code: t('code'),
            description: t('description'),
            rate: t('rate'),
            ...(dialog.value ? { isActive: active } : {}),
          },
        );
        break;
      case 'pto':
        ok = await m.run(
          dialog.value ? `/pto-policies/${dialog.value.id}` : '/pto-policies',
          dialog.value ? 'PUT' : 'POST',
          {
            name: t('name'),
            kind: t('kind'),
            accrualMethod: t('accrualMethod'),
            accrualRate: t('accrualRate') || '0',
            maxBalance: t('maxBalance'),
            carryoverLimit: t('carryoverLimit'),
            ...(dialog.value ? { isActive: active } : {}),
          },
        );
        break;
      case 'item':
        ok = await m.run(
          dialog.value ? `/items/${dialog.value.id}` : '/items',
          dialog.value ? 'PUT' : 'POST',
          {
            name: t('name'),
            kind: itemKind,
            rateMultiplier: t('rateMultiplier'),
            ptoPolicyId: t('ptoPolicyId') || null,
            garnishmentType: t('garnishmentType') || null,
            expenseAccountId: t('expenseAccountId') || null,
            liabilityAccountId: t('liabilityAccountId') || null,
            vendorId: t('vendorId') || null,
            ...(dialog.value ? { isActive: active } : {}),
          },
        );
        break;
    }
    if (ok) setDialog(null);
  }

  const itemCategory = payrollItemCategory(itemKind);
  const fe = m.fieldError;
  const manage = (d: DialogState, label: string) =>
    canManage && (
      <Button size="sm" variant="ghost" onClick={() => open(d)}>
        {label}
      </Button>
    );

  // The forms below are uncontrolled: render them once their options are loaded, so each
  // select starts on its saved value rather than the first option.
  if (lookups.isPending) return <Spinner />;

  return (
    <>
      {m.error && !dialog && (
        <div className="mb-4">
          <Alert>{errText(m.error)}</Alert>
        </div>
      )}
      <Section
        title="Company payroll settings"
        description="The federal return and deposit schedule, the accounts payroll posts to, and your bank for direct deposit."
        testId="payroll-settings"
      >
        {!settings.hasEin && (
          <div className="mb-4">
            <Alert kind="info">
              Add the company&apos;s EIN in Settings before running payroll.
            </Alert>
          </div>
        )}
        {saved && (
          <div className="mb-4">
            <Alert kind="success">Payroll settings saved.</Alert>
          </div>
        )}
        <form onSubmit={saveSettings} className="space-y-4" aria-label="Payroll settings">
          <fieldset disabled={!canManage} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Select
              label="Federal return"
              name="federalForm"
              defaultValue={settings.federalForm}
              options={FEDERAL_FORMS.map((v) => ({ value: v, label: FEDERAL_FORM_LABELS[v] }))}
            />
            <Select
              label="Federal deposit schedule"
              name="depositSchedule"
              defaultValue={settings.depositSchedule}
              options={DEPOSIT_SCHEDULES.map((v) => ({
                value: v,
                label: DEPOSIT_SCHEDULE_LABELS[v],
              }))}
            />
            <TextInput
              label="First payroll here"
              name="payrollStartDate"
              type="date"
              defaultValue={settings.payrollStartDate ?? ''}
              hint="Earlier pay this year is entered as prior payroll."
            />
            <Select
              label="Wage expense account"
              name="wageExpenseAccountId"
              defaultValue={settings.wageExpenseAccountId}
              options={accountOptions(lookups.data, 'expense')}
              error={fe('wageExpenseAccountId')}
            />
            <Select
              label="Payroll tax expense account"
              name="taxExpenseAccountId"
              defaultValue={settings.taxExpenseAccountId}
              options={accountOptions(lookups.data, 'expense')}
              error={fe('taxExpenseAccountId')}
            />
            <Select
              label="Payroll liabilities account"
              name="liabilityAccountId"
              defaultValue={settings.liabilityAccountId}
              options={accountOptions(lookups.data, 'liability')}
              error={fe('liabilityAccountId')}
            />
            <Select
              label="Pay employees from"
              name="bankAccountId"
              defaultValue={settings.bankAccountId ?? ''}
              placeholder="Choose a bank account"
              options={accountOptions(lookups.data, 'bank')}
              error={fe('bankAccountId')}
            />
            <TextInput
              label="Your bank's routing number (ODFI)"
              name="achOdfiRouting"
              inputMode="numeric"
              defaultValue={settings.achOdfiRouting ?? ''}
              error={fe('achOdfiRouting')}
            />
            <TextInput
              label="Your bank's name"
              name="achOdfiName"
              maxLength={23}
              defaultValue={settings.achOdfiName ?? ''}
              error={fe('achOdfiName')}
            />
            <TextInput
              label="Company name on deposits"
              name="achCompanyName"
              maxLength={16}
              defaultValue={settings.achCompanyName ?? ''}
              hint="Up to 16 characters; shown on employees' bank statements."
            />
            <TextInput
              label="ACH company ID"
              name="achCompanyId"
              maxLength={10}
              defaultValue={settings.achCompanyId ?? ''}
              hint="From your bank. Leave blank to use 1 followed by the EIN."
              error={fe('achCompanyId')}
            />
          </fieldset>
          {canManage && (
            <div className="flex justify-end">
              <Button type="submit" loading={m.busy && !dialog}>
                Save settings
              </Button>
            </div>
          )}
        </form>
      </Section>

      <Section
        title="Pay schedules"
        testId="pay-schedules"
        actions={
          canManage && (
            <Button variant="secondary" onClick={() => open({ kind: 'schedule' })}>
              Add pay schedule
            </Button>
          )
        }
      >
        {(schedules.data ?? []).length === 0 ? (
          <p className="text-sm text-gray-600">No pay schedules yet.</p>
        ) : (
          <Table
            label="Pay schedules"
            headers={['Name', 'How often', 'Next period', 'Next pay date', '']}
          >
            {schedules.data!.map((s) => (
              <tr key={s.id}>
                <td className="px-2 py-2">
                  {s.name} {!s.isActive && <Badge>Inactive</Badge>}
                </td>
                <td className="px-2 py-2">{PAY_FREQUENCY_LABELS[s.frequency]}</td>
                <td className="px-2 py-2">
                  {s.upcoming[0] &&
                    `${formatDate(s.upcoming[0].start)} – ${formatDate(s.upcoming[0].end)}`}
                </td>
                <td className="px-2 py-2">{s.upcoming[0] && formatDate(s.upcoming[0].payDate)}</td>
                <td className="px-2 py-2 text-right">
                  {manage({ kind: 'schedule', value: s }, 'Edit')}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section
        title="States"
        description="Your state account numbers and each year's unemployment rate from the state's notice."
        testId="payroll-states"
        actions={
          canManage && (
            <Button variant="secondary" onClick={() => open({ kind: 'state' })}>
              Add state
            </Button>
          )
        }
      >
        {(states.data ?? []).length === 0 ? (
          <p className="text-sm text-gray-600">No states yet.</p>
        ) : (
          <Table
            label="States"
            headers={[
              'State',
              'Withholding account',
              'Unemployment account',
              'Deposit schedule',
              'Unemployment rate',
              '',
            ]}
          >
            {states.data!.map((s) => (
              <tr key={s.id}>
                <td className="px-2 py-2">{PAYROLL_STATE_LABELS[s.state]}</td>
                <td className="px-2 py-2">{s.withholdingAccountNumber ?? '—'}</td>
                <td className="px-2 py-2">{s.unemploymentAccountNumber ?? '—'}</td>
                <td className="px-2 py-2">
                  {s.withholdingDepositSchedule === 'semiweekly'
                    ? 'Semiweekly'
                    : s.withholdingDepositSchedule === 'monthly'
                      ? 'Monthly'
                      : '—'}
                </td>
                <td className="px-2 py-2">
                  {s.unemploymentRates.map((r) => `${r.year}: ${r.rate}%`).join(', ') || '—'}
                </td>
                <td className="px-2 py-2 text-right">
                  {manage({ kind: 'rate', value: s }, 'Set rate')}
                  {manage({ kind: 'state', value: s }, 'Edit')}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section
        title="Workers' compensation"
        description="Class codes and rates per $100 of wages from your policy."
        testId="workers-comp"
        actions={
          canManage && (
            <Button variant="secondary" onClick={() => open({ kind: 'workers-comp' })}>
              Add class
            </Button>
          )
        }
      >
        {(workersComp.data ?? []).length === 0 ? (
          <p className="text-sm text-gray-600">No classes yet.</p>
        ) : (
          <Table
            label="Workers' comp classes"
            headers={['State', 'Code', 'Description', 'Rate per $100', '']}
          >
            {workersComp.data!.map((w) => (
              <tr key={w.id}>
                <td className="px-2 py-2">{w.state}</td>
                <td className="px-2 py-2">{w.code}</td>
                <td className="px-2 py-2">
                  {w.description} {!w.isActive && <Badge>Inactive</Badge>}
                </td>
                <td className="px-2 py-2">{w.rate}</td>
                <td className="px-2 py-2 text-right">
                  {manage({ kind: 'workers-comp', value: w }, 'Edit')}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section
        title="Paid time off policies"
        testId="pto-policies"
        actions={
          canManage && (
            <Button variant="secondary" onClick={() => open({ kind: 'pto' })}>
              Add PTO policy
            </Button>
          )
        }
      >
        {(pto.data ?? []).length === 0 ? (
          <p className="text-sm text-gray-600">No PTO policies yet.</p>
        ) : (
          <Table label="PTO policies" headers={['Name', 'Kind', 'Accrual', 'Maximum', '']}>
            {pto.data!.map((p) => (
              <tr key={p.id}>
                <td className="px-2 py-2">
                  {p.name} {!p.isActive && <Badge>Inactive</Badge>}
                </td>
                <td className="px-2 py-2">{PTO_KIND_LABELS[p.kind]}</td>
                <td className="px-2 py-2">
                  {p.accrualMethod === 'none'
                    ? PTO_ACCRUAL_LABELS.none
                    : `${p.accrualRate} ${PTO_ACCRUAL_LABELS[p.accrualMethod].toLowerCase()}`}
                </td>
                <td className="px-2 py-2">{p.maxBalance ? `${p.maxBalance} hours` : '—'}</td>
                <td className="px-2 py-2 text-right">
                  {manage({ kind: 'pto', value: p }, 'Edit')}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section
        title="Payroll items"
        description="Earnings, deductions and company contributions. How each is taxed follows from its kind and the year's tax tables."
        testId="payroll-items"
        actions={
          canManage && (
            <Button
              variant="secondary"
              onClick={() => {
                setItemKind('bonus');
                open({ kind: 'item' });
              }}
            >
              Add payroll item
            </Button>
          )
        }
      >
        {PAYROLL_ITEM_CATEGORIES.map((cat) => {
          const list = (items.data ?? []).filter((i) => i.category === cat);
          if (list.length === 0) return null;
          return (
            <div key={cat} className="mb-4">
              <h3 className="mb-1 text-sm font-semibold text-gray-800">
                {PAYROLL_ITEM_CATEGORY_LABELS[cat]}
              </h3>
              <Table
                label={PAYROLL_ITEM_CATEGORY_LABELS[cat]}
                headers={['Name', 'Kind', 'Account', 'Paid to', '']}
              >
                {list.map((i) => (
                  <tr key={i.id}>
                    <td className="px-2 py-2">
                      {i.name} {!i.isActive && <Badge>Inactive</Badge>}
                    </td>
                    <td className="px-2 py-2">
                      {PAYROLL_ITEM_KINDS[i.kind].label}
                      {i.rateMultiplier && ` (×${i.rateMultiplier})`}
                    </td>
                    <td className="px-2 py-2">
                      {accountName(i.expenseAccountId ?? i.liabilityAccountId) || (
                        <span className="text-gray-500">Default</span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {lookups.data?.vendors.find((v) => v.id === i.vendorId)?.displayName ?? ''}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {canManage && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setItemKind(i.kind);
                            open({ kind: 'item', value: i });
                          }}
                        >
                          Edit
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            </div>
          );
        })}
      </Section>

      <Dialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={dialog ? dialogTitle(dialog) : ''}
      >
        {dialog && (
          <form onSubmit={submitDialog} className="space-y-4">
            {m.error && <Alert>{errText(m.error)}</Alert>}
            {dialog.kind === 'schedule' && (
              <>
                <TextInput
                  label="Name"
                  name="name"
                  defaultValue={dialog.value?.name ?? ''}
                  error={fe('name')}
                />
                <Select
                  label="How often"
                  name="frequency"
                  defaultValue={dialog.value?.frequency ?? 'biweekly'}
                  options={PAY_FREQUENCIES.map((v) => ({
                    value: v,
                    label: PAY_FREQUENCY_LABELS[v],
                  }))}
                />
                <TextInput
                  label="A pay period ends on"
                  name="firstPeriodEnd"
                  type="date"
                  defaultValue={dialog.value?.firstPeriodEnd ?? ''}
                  error={fe('firstPeriodEnd')}
                  hint="Any period's last day; the others follow."
                />
                <TextInput
                  label="Days from period end to pay date"
                  name="payDateOffset"
                  type="number"
                  min={0}
                  max={30}
                  defaultValue={String(dialog.value?.payDateOffset ?? 0)}
                  hint="Weekend pay dates move to the Friday before."
                />
                {dialog.value && (
                  <Checkbox label="Active" name="isActive" defaultChecked={dialog.value.isActive} />
                )}
              </>
            )}
            {dialog.kind === 'state' && (
              <>
                {!dialog.value && (
                  <Select
                    label="State"
                    name="state"
                    options={PAYROLL_STATES.filter(
                      (s) => !states.data?.some((r) => r.state === s),
                    ).map((s) => ({
                      value: s,
                      label: PAYROLL_STATE_LABELS[s],
                    }))}
                  />
                )}
                <TextInput
                  label="Withholding account number"
                  name="withholdingAccountNumber"
                  defaultValue={dialog.value?.withholdingAccountNumber ?? ''}
                  hint="Leave blank for states without income tax (Florida, Texas)."
                />
                <TextInput
                  label="Unemployment account number"
                  name="unemploymentAccountNumber"
                  defaultValue={dialog.value?.unemploymentAccountNumber ?? ''}
                />
                <Select
                  label="Withholding deposit schedule"
                  name="withholdingDepositSchedule"
                  defaultValue={dialog.value?.withholdingDepositSchedule ?? ''}
                  options={[
                    { value: '', label: 'Not set (the schedule for new employers)' },
                    { value: 'monthly', label: 'Monthly' },
                    { value: 'semiweekly', label: 'Semiweekly' },
                  ]}
                  hint="The payment schedule on your state notice. Illinois due dates follow it."
                />
              </>
            )}
            {dialog.kind === 'rate' && (
              <>
                <TextInput
                  label="Year"
                  name="year"
                  type="number"
                  defaultValue={String(new Date().getFullYear())}
                  error={fe('year')}
                />
                <TextInput
                  label="Rate (%)"
                  name="rate"
                  inputMode="decimal"
                  error={fe('rate')}
                  hint="From the state's rate notice for that year."
                />
              </>
            )}
            {dialog.kind === 'workers-comp' && (
              <>
                <Select
                  label="State"
                  name="state"
                  defaultValue={dialog.value?.state ?? PAYROLL_STATES[0]}
                  options={PAYROLL_STATES.map((s) => ({
                    value: s,
                    label: PAYROLL_STATE_LABELS[s],
                  }))}
                />
                <TextInput
                  label="Class code"
                  name="code"
                  defaultValue={dialog.value?.code ?? ''}
                  error={fe('code')}
                />
                <TextInput
                  label="Description"
                  name="description"
                  defaultValue={dialog.value?.description ?? ''}
                  error={fe('description')}
                />
                <TextInput
                  label="Rate per $100 of wages"
                  name="rate"
                  inputMode="decimal"
                  defaultValue={dialog.value?.rate ?? ''}
                  error={fe('rate')}
                />
                {dialog.value && (
                  <Checkbox label="Active" name="isActive" defaultChecked={dialog.value.isActive} />
                )}
              </>
            )}
            {dialog.kind === 'pto' && (
              <>
                <TextInput
                  label="Name"
                  name="name"
                  defaultValue={dialog.value?.name ?? ''}
                  error={fe('name')}
                />
                <Select
                  label="Kind"
                  name="kind"
                  defaultValue={dialog.value?.kind ?? 'vacation'}
                  options={PTO_KINDS.map((k) => ({ value: k, label: PTO_KIND_LABELS[k] }))}
                />
                <Select
                  label="Accrual"
                  name="accrualMethod"
                  defaultValue={dialog.value?.accrualMethod ?? 'per_hour_worked'}
                  options={PTO_ACCRUAL_METHODS.map((k) => ({
                    value: k,
                    label: PTO_ACCRUAL_LABELS[k],
                  }))}
                />
                <TextInput
                  label="Hours accrued"
                  name="accrualRate"
                  inputMode="decimal"
                  defaultValue={dialog.value?.accrualRate ?? ''}
                  error={fe('accrualRate')}
                  hint="e.g. 0.0385 per hour worked (1 hour per 26), or 4 per paycheck."
                />
                <TextInput
                  label="Maximum balance (hours)"
                  name="maxBalance"
                  inputMode="decimal"
                  defaultValue={dialog.value?.maxBalance ?? ''}
                  error={fe('maxBalance')}
                />
                <TextInput
                  label="Carryover limit (hours)"
                  name="carryoverLimit"
                  inputMode="decimal"
                  defaultValue={dialog.value?.carryoverLimit ?? ''}
                  error={fe('carryoverLimit')}
                />
                {dialog.value && (
                  <Checkbox label="Active" name="isActive" defaultChecked={dialog.value.isActive} />
                )}
              </>
            )}
            {dialog.kind === 'item' && (
              <>
                <Select
                  label="Kind"
                  value={itemKind}
                  onChange={(e) => setItemKind(e.target.value as PayrollItemKind)}
                  options={PAYROLL_ITEM_KIND_LIST.map((k) => ({
                    value: k,
                    label: `${PAYROLL_ITEM_CATEGORY_LABELS[PAYROLL_ITEM_KINDS[k].category]}: ${PAYROLL_ITEM_KINDS[k].label}`,
                  }))}
                />
                <TextInput
                  label="Name"
                  name="name"
                  defaultValue={dialog.value?.name ?? ''}
                  error={fe('name')}
                />
                {(itemKind === 'overtime' || itemKind === 'double_time') && (
                  <TextInput
                    label="Multiple of the regular rate"
                    name="rateMultiplier"
                    inputMode="decimal"
                    defaultValue={
                      dialog.value?.rateMultiplier ?? (itemKind === 'overtime' ? '1.5' : '2')
                    }
                    error={fe('rateMultiplier')}
                  />
                )}
                {itemKind === 'garnishment' && (
                  <Select
                    label="Garnishment type"
                    name="garnishmentType"
                    defaultValue={dialog.value?.garnishmentType ?? 'child_support'}
                    options={GARNISHMENT_TYPES.map((g) => ({
                      value: g,
                      label: GARNISHMENT_TYPE_LABELS[g],
                    }))}
                  />
                )}
                {['vacation', 'sick', 'holiday', 'other_earning'].includes(itemKind) &&
                  (pto.data ?? []).length > 0 && (
                    <Select
                      label="Draws from PTO policy"
                      name="ptoPolicyId"
                      defaultValue={dialog.value?.ptoPolicyId ?? ''}
                      placeholder="None"
                      options={pto.data!.map((p) => ({ value: p.id, label: p.name }))}
                    />
                  )}
                {(itemCategory === 'earning' || itemCategory === 'employer_contribution') && (
                  <Select
                    label="Expense account"
                    name="expenseAccountId"
                    defaultValue={dialog.value?.expenseAccountId ?? ''}
                    placeholder="Default (payroll settings)"
                    options={accountOptions(lookups.data, 'expense')}
                    error={fe('expenseAccountId')}
                  />
                )}
                {itemCategory !== 'earning' && (
                  <>
                    <Select
                      label="Liability account"
                      name="liabilityAccountId"
                      defaultValue={dialog.value?.liabilityAccountId ?? ''}
                      placeholder="Default (payroll settings)"
                      options={accountOptions(lookups.data, 'liability')}
                      error={fe('liabilityAccountId')}
                    />
                    <Select
                      label="Paid to"
                      name="vendorId"
                      defaultValue={dialog.value?.vendorId ?? ''}
                      placeholder="—"
                      options={(lookups.data?.vendors ?? []).map((v) => ({
                        value: v.id,
                        label: v.displayName,
                      }))}
                    />
                  </>
                )}
                {dialog.value && (
                  <Checkbox label="Active" name="isActive" defaultChecked={dialog.value.isActive} />
                )}
              </>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button type="submit" loading={m.busy}>
                Save
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}
