'use client';

import { useState, type FormEvent } from 'react';
import {
  BANK_ACCOUNT_TYPES,
  DE4_STATUS_LABELS,
  DE4_STATUSES,
  DEPOSIT_AMOUNT_TYPE_LABELS,
  DEPOSIT_AMOUNT_TYPES,
  formatDate,
  IT2104_STATUS_LABELS,
  IT2104_STATUSES,
  MAX_DEPOSIT_ACCOUNTS,
  PAYROLL_ITEM_CATEGORY_LABELS,
  PAYROLL_STATE_LABELS,
  STATE_CERTIFICATE_FORMS,
  todayIso,
  W4_2020_STATUS_LABELS,
  W4_2020_STATUSES,
  W4_PRE2020_STATUS_LABELS,
  W4_PRE2020_STATUSES,
  type BankAccountType,
  type DepositAmountType,
  type EmployeeDto,
  type PayrollState,
  type StateCertificateDto,
  type W4Dto,
  type W4Version,
} from '@acct/shared';
import { Alert, Badge, Button, Dialog, TextInput } from '@/components/ui';
import { useAccess, usePayrollItems, usePtoPolicies } from '@/lib/queries';
import {
  cellInputClass,
  Checkbox,
  dollars,
  errText,
  formField,
  Section,
  Select,
  Table,
  usePayrollMutation,
} from './payroll-ui';

type Props = { companyId: string; employee: EmployeeDto };

function w4Status(w: W4Dto): string {
  return w.formVersion === '2020'
    ? W4_2020_STATUS_LABELS[w.filingStatus as keyof typeof W4_2020_STATUS_LABELS]
    : W4_PRE2020_STATUS_LABELS[w.filingStatus as keyof typeof W4_PRE2020_STATUS_LABELS];
}

// --- Form W-4 ----------------------------------------------------------------------------------
export function W4Section({ companyId, employee }: Props) {
  const canManage = useAccess(companyId).can('payroll.manage');
  const m = usePayrollMutation(companyId);
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState<W4Version>('2020');
  const url = `/employees/${employee.id}/w4`;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const common = {
      formVersion: version,
      effectiveFrom: formField(f, 'effectiveFrom'),
      filingStatus: formField(f, 'filingStatus'),
      extraWithholding: formField(f, 'extraWithholding'),
      exempt: f.get('exempt') === 'on',
      nonresidentAlien: f.get('nonresidentAlien') === 'on',
    };
    const body =
      version === '2020'
        ? {
            ...common,
            multipleJobs: f.get('multipleJobs') === 'on',
            dependentsAmount: formField(f, 'dependentsAmount'),
            otherIncome: formField(f, 'otherIncome'),
            deductions: formField(f, 'deductions'),
          }
        : { ...common, allowances: Number(formField(f, 'allowances') || 0) };
    if (await m.run(url, 'POST', body)) setOpen(false);
  }
  async function remove(w: W4Dto) {
    if (!window.confirm(`Remove the Form W-4 effective ${formatDate(w.effectiveFrom)}?`)) return;
    await m.run(`${url}/${w.id}`, 'DELETE');
  }

  return (
    <Section
      title="Federal withholding (Form W-4)"
      description="Payroll uses the form in effect on each pay date. Keep earlier forms for the record."
      testId="w4"
      actions={
        canManage && (
          <Button
            variant="secondary"
            onClick={() => {
              m.setError(null);
              setOpen(true);
            }}
          >
            Add Form W-4
          </Button>
        )
      }
    >
      {m.error && !open && <Alert>{errText(m.error)}</Alert>}
      {employee.w4.length === 0 ? (
        <p className="text-sm text-gray-600">
          No Form W-4 on file. Until one is, withholding treats the employee as single with no
          adjustments.
        </p>
      ) : (
        <Table
          label="Forms W-4"
          headers={['Effective', 'Form', 'Filing status', 'Details', 'Extra per paycheck', '']}
        >
          {employee.w4.map((w, i) => (
            <tr key={w.id}>
              <td className="px-2 py-2">
                {formatDate(w.effectiveFrom)} {i === 0 && <Badge tone="green">Current</Badge>}
              </td>
              <td className="px-2 py-2">
                {w.formVersion === '2020' ? '2020 or later' : '2019 or earlier'}
              </td>
              <td className="px-2 py-2">{w.exempt ? 'Exempt' : w4Status(w)}</td>
              <td className="px-2 py-2 text-xs text-gray-700">
                {w.formVersion === '2020'
                  ? [
                      w.multipleJobs && 'Step 2(c) checked',
                      w.dependentsAmount !== '0.00' && `Dependents ${dollars(w.dependentsAmount)}`,
                      w.otherIncome !== '0.00' && `Other income ${dollars(w.otherIncome)}`,
                      w.deductions !== '0.00' && `Deductions ${dollars(w.deductions)}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : `${w.allowances} allowance${w.allowances === 1 ? '' : 's'}`}
                {w.nonresidentAlien && ' · Nonresident alien'}
              </td>
              <td className="px-2 py-2">{dollars(w.extraWithholding)}</td>
              <td className="px-2 py-2 text-right">
                {canManage && (
                  <Button size="sm" variant="ghost" onClick={() => remove(w)}>
                    Remove
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title="Add Form W-4" wide>
        <form onSubmit={submit} className="space-y-4">
          {m.error && <Alert>{errText(m.error)}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              label="Form version"
              value={version}
              onChange={(e) => setVersion(e.target.value as W4Version)}
              options={[
                { value: '2020', label: '2020 or later' },
                { value: 'pre2020', label: '2019 or earlier (never refiled)' },
              ]}
            />
            <TextInput
              label="Effective from"
              name="effectiveFrom"
              type="date"
              defaultValue={todayIso()}
              error={m.fieldError('effectiveFrom')}
            />
            <Select
              key={version}
              label="Filing status (Step 1c)"
              name="filingStatus"
              options={
                version === '2020'
                  ? W4_2020_STATUSES.map((s) => ({ value: s, label: W4_2020_STATUS_LABELS[s] }))
                  : W4_PRE2020_STATUSES.map((s) => ({
                      value: s,
                      label: W4_PRE2020_STATUS_LABELS[s],
                    }))
              }
            />
            {version === '2020' ? (
              <>
                <div className="flex items-end pb-2">
                  <Checkbox label="Step 2(c): multiple jobs or spouse works" name="multipleJobs" />
                </div>
                <TextInput
                  label="Step 3: dependents amount"
                  name="dependentsAmount"
                  inputMode="decimal"
                  error={m.fieldError('dependentsAmount')}
                />
                <TextInput
                  label="Step 4(a): other income"
                  name="otherIncome"
                  inputMode="decimal"
                  error={m.fieldError('otherIncome')}
                />
                <TextInput
                  label="Step 4(b): deductions"
                  name="deductions"
                  inputMode="decimal"
                  error={m.fieldError('deductions')}
                />
                <TextInput
                  label="Step 4(c): extra withholding"
                  name="extraWithholding"
                  inputMode="decimal"
                  error={m.fieldError('extraWithholding')}
                />
              </>
            ) : (
              <>
                <TextInput
                  label="Allowances (line 5)"
                  name="allowances"
                  type="number"
                  min={0}
                  max={99}
                  defaultValue="0"
                  error={m.fieldError('allowances')}
                />
                <TextInput
                  label="Additional amount (line 6)"
                  name="extraWithholding"
                  inputMode="decimal"
                  error={m.fieldError('extraWithholding')}
                />
              </>
            )}
            <Checkbox label="Claims exemption from withholding" name="exempt" />
            <Checkbox label="Nonresident alien" name="nonresidentAlien" />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={m.busy}>
              Save Form W-4
            </Button>
          </div>
        </form>
      </Dialog>
    </Section>
  );
}

// --- State certificates -------------------------------------------------------------------------
const CERT_STATES = (Object.keys(STATE_CERTIFICATE_FORMS) as PayrollState[]).filter(
  (s) => STATE_CERTIFICATE_FORMS[s],
) as Array<'CA' | 'IL' | 'NY'>;

function certificateSummary(c: StateCertificateDto): string {
  const extra = (v: string) => (v && v !== '0' ? dollars(v) : null);
  if (c.fields.exempt) return 'Exempt';
  switch (c.state) {
    case 'IL':
      return [
        `${c.fields.basicAllowances} basic, ${c.fields.additionalAllowances} additional allowances`,
        extra(c.fields.additionalWithholding) && `extra ${extra(c.fields.additionalWithholding)}`,
      ]
        .filter(Boolean)
        .join(' · ');
    case 'CA':
      return [
        DE4_STATUS_LABELS[c.fields.filingStatus],
        `${c.fields.regularAllowances} + ${c.fields.estimatedDeductionAllowances} allowances`,
        c.fields.militarySpouseExempt && 'military spouse, not subject to withholding',
        extra(c.fields.additionalWithholding) && `extra ${extra(c.fields.additionalWithholding)}`,
      ]
        .filter(Boolean)
        .join(' · ');
    case 'NY':
      return [
        IT2104_STATUS_LABELS[c.fields.filingStatus],
        `${c.fields.stateAllowances} state allowances`,
        c.fields.nycResident && `NYC resident, ${c.fields.cityAllowances} city allowances`,
        c.fields.yonkersResident && 'Yonkers resident',
        extra(c.fields.additionalState) && `extra state ${extra(c.fields.additionalState)}`,
      ]
        .filter(Boolean)
        .join(' · ');
  }
}

export function StateCertificateSection({ companyId, employee }: Props) {
  const canManage = useAccess(companyId).can('payroll.manage');
  const m = usePayrollMutation(companyId);
  const [open, setOpen] = useState(false);
  const defaultState = (CERT_STATES as string[]).includes(employee.workState)
    ? (employee.workState as 'CA' | 'IL' | 'NY')
    : 'IL';
  const [state, setState] = useState<'CA' | 'IL' | 'NY'>(defaultState);
  const url = `/employees/${employee.id}/state-certificates`;
  const noIncomeTax = STATE_CERTIFICATE_FORMS[employee.workState] === null;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const n = (k: string) => Number(formField(f, k) || 0);
    const on = (k: string) => f.get(k) === 'on';
    const fields =
      state === 'IL'
        ? {
            basicAllowances: n('basicAllowances'),
            additionalAllowances: n('additionalAllowances'),
            additionalWithholding: formField(f, 'additionalWithholding'),
            exempt: on('exempt'),
          }
        : state === 'CA'
          ? {
              filingStatus: formField(f, 'filingStatus'),
              regularAllowances: n('regularAllowances'),
              estimatedDeductionAllowances: n('estimatedDeductionAllowances'),
              additionalWithholding: formField(f, 'additionalWithholding'),
              exempt: on('exempt'),
              militarySpouseExempt: on('militarySpouseExempt'),
            }
          : {
              filingStatus: formField(f, 'filingStatus'),
              nycResident: on('nycResident'),
              yonkersResident: on('yonkersResident'),
              stateAllowances: n('stateAllowances'),
              cityAllowances: n('cityAllowances'),
              additionalState: formField(f, 'additionalState'),
              additionalCity: formField(f, 'additionalCity'),
              additionalYonkers: formField(f, 'additionalYonkers'),
              exempt: on('exempt'),
            };
    const body = { state, effectiveFrom: formField(f, 'effectiveFrom'), fields };
    if (await m.run(url, 'POST', body)) setOpen(false);
  }
  async function remove(c: StateCertificateDto) {
    if (!window.confirm(`Remove this ${STATE_CERTIFICATE_FORMS[c.state]}?`)) return;
    await m.run(`${url}/${c.id}`, 'DELETE');
  }
  const fe = (k: string) => m.fieldError(`fields.${k}`);

  return (
    <Section
      title="State withholding"
      description={
        noIncomeTax
          ? `${PAYROLL_STATE_LABELS[employee.workState]} has no state income tax.`
          : 'The state withholding certificate (IL-W-4, DE 4 or IT-2104).'
      }
      testId="state-certificates"
      actions={
        canManage && (
          <Button
            variant="secondary"
            onClick={() => {
              m.setError(null);
              setOpen(true);
            }}
          >
            Add state certificate
          </Button>
        )
      }
    >
      {m.error && !open && <Alert>{errText(m.error)}</Alert>}
      {employee.stateCertificates.length === 0 ? (
        <p className="text-sm text-gray-600">No state certificate on file.</p>
      ) : (
        <Table label="State certificates" headers={['State', 'Form', 'Effective', 'Details', '']}>
          {employee.stateCertificates.map((c) => (
            <tr key={c.id}>
              <td className="px-2 py-2">{PAYROLL_STATE_LABELS[c.state]}</td>
              <td className="px-2 py-2">{STATE_CERTIFICATE_FORMS[c.state]}</td>
              <td className="px-2 py-2">{formatDate(c.effectiveFrom)}</td>
              <td className="px-2 py-2 text-xs text-gray-700">{certificateSummary(c)}</td>
              <td className="px-2 py-2 text-right">
                {canManage && (
                  <Button size="sm" variant="ghost" onClick={() => remove(c)}>
                    Remove
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title="Add state certificate" wide>
        <form onSubmit={submit} className="space-y-4">
          {m.error && <Alert>{errText(m.error)}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              label="State"
              value={state}
              onChange={(e) => setState(e.target.value as typeof state)}
              options={CERT_STATES.map((s) => ({
                value: s,
                label: `${PAYROLL_STATE_LABELS[s]} (${STATE_CERTIFICATE_FORMS[s]})`,
              }))}
            />
            <TextInput
              label="Effective from"
              name="effectiveFrom"
              type="date"
              defaultValue={todayIso()}
              error={m.fieldError('effectiveFrom')}
            />
            {state === 'IL' && (
              <>
                <TextInput
                  label="Basic allowances (line 1)"
                  name="basicAllowances"
                  type="number"
                  min={0}
                  max={99}
                  defaultValue="1"
                  error={fe('basicAllowances')}
                />
                <TextInput
                  label="Additional allowances (line 2)"
                  name="additionalAllowances"
                  type="number"
                  min={0}
                  max={99}
                  defaultValue="0"
                  error={fe('additionalAllowances')}
                />
                <TextInput
                  label="Additional withholding (line 3)"
                  name="additionalWithholding"
                  inputMode="decimal"
                  error={fe('additionalWithholding')}
                />
              </>
            )}
            {state === 'CA' && (
              <>
                <Select
                  label="DE 4 filing status"
                  name="filingStatus"
                  options={DE4_STATUSES.map((s) => ({ value: s, label: DE4_STATUS_LABELS[s] }))}
                />
                <TextInput
                  label="Regular allowances (line 1a)"
                  name="regularAllowances"
                  type="number"
                  min={0}
                  max={99}
                  defaultValue="0"
                  error={fe('regularAllowances')}
                />
                <TextInput
                  label="Estimated deduction allowances (line 1b)"
                  name="estimatedDeductionAllowances"
                  type="number"
                  min={0}
                  max={99}
                  defaultValue="0"
                  error={fe('estimatedDeductionAllowances')}
                />
                <TextInput
                  label="Additional withholding (line 2)"
                  name="additionalWithholding"
                  inputMode="decimal"
                  error={fe('additionalWithholding')}
                />
                <Checkbox
                  label="Not subject to California withholding as a military spouse (line 4)"
                  name="militarySpouseExempt"
                />
              </>
            )}
            {state === 'NY' && (
              <>
                <Select
                  label="IT-2104 filing status"
                  name="filingStatus"
                  options={IT2104_STATUSES.map((s) => ({
                    value: s,
                    label: IT2104_STATUS_LABELS[s],
                  }))}
                />
                <TextInput
                  label="State allowances (line 1)"
                  name="stateAllowances"
                  type="number"
                  min={0}
                  max={99}
                  defaultValue="0"
                  error={fe('stateAllowances')}
                />
                <div className="space-y-2 pt-6">
                  <Checkbox label="Lives in New York City" name="nycResident" />
                  <Checkbox label="Lives in Yonkers" name="yonkersResident" />
                </div>
                <TextInput
                  label="City allowances (line 2)"
                  name="cityAllowances"
                  type="number"
                  min={0}
                  max={99}
                  defaultValue="0"
                  error={fe('cityAllowances')}
                />
                <TextInput
                  label="Additional state withholding (line 3)"
                  name="additionalState"
                  inputMode="decimal"
                  error={fe('additionalState')}
                />
                <TextInput
                  label="Additional city withholding (line 4)"
                  name="additionalCity"
                  inputMode="decimal"
                  error={fe('additionalCity')}
                />
                <TextInput
                  label="Additional Yonkers withholding (line 5)"
                  name="additionalYonkers"
                  inputMode="decimal"
                  error={fe('additionalYonkers')}
                />
              </>
            )}
            <Checkbox label="Claims exemption from state withholding" name="exempt" />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={m.busy}>
              Save certificate
            </Button>
          </div>
        </form>
      </Dialog>
    </Section>
  );
}

// --- Direct deposit -------------------------------------------------------------------------------
interface AccountRow {
  key: string;
  id?: string;
  accountMasked?: string;
  routingNumber: string;
  accountNumber: string;
  accountType: BankAccountType;
  amountType: DepositAmountType;
  amount: string;
  prenote: boolean;
  prenoteLabel?: string;
}

function accountRows(employee: EmployeeDto): AccountRow[] {
  return employee.bankAccounts.map((a) => ({
    key: a.id,
    id: a.id,
    accountMasked: a.accountMasked,
    routingNumber: a.routingNumber,
    accountNumber: '',
    accountType: a.accountType,
    amountType: a.amountType,
    amount: a.amount ?? '',
    prenote: a.prenoteStatus !== 'none',
    prenoteLabel:
      a.prenoteStatus === 'sent'
        ? `Prenote sent ${a.prenoteSentOn ? formatDate(a.prenoteSentOn) : ''}`
        : a.prenoteStatus === 'pending'
          ? 'Prenote waiting to be sent'
          : undefined,
  }));
}

export function DirectDepositSection({ companyId, employee }: Props) {
  const canManage = useAccess(companyId).can('payroll.manage');
  const m = usePayrollMutation(companyId);
  const [rows, setRows] = useState<AccountRow[]>(() => accountRows(employee));
  const [saved, setSaved] = useState(false);
  const set = (i: number, patch: Partial<AccountRow>) => {
    setSaved(false);
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };

  async function save() {
    const body = {
      accounts: rows.map((r) => ({
        ...(r.id ? { id: r.id } : {}),
        routingNumber: r.routingNumber.trim(),
        ...(r.accountNumber.trim() ? { accountNumber: r.accountNumber.trim() } : {}),
        accountType: r.accountType,
        amountType: r.amountType,
        amount: r.amountType === 'remainder' ? '' : r.amount,
        prenote: r.prenote,
      })),
    };
    const result = await m.run<EmployeeDto>(`/employees/${employee.id}/bank-accounts`, 'PUT', body);
    if (result) {
      setRows(accountRows(result));
      setSaved(true);
    }
  }
  const fe = (i: number, k: string) => m.fieldError(`accounts.${i}.${k}`);

  return (
    <Section
      title="Direct deposit"
      description="Up to three accounts. Account numbers are stored encrypted."
      testId="direct-deposit"
    >
      {m.error && (
        <div className="mb-3">
          <Alert>{errText(m.error)}</Alert>
        </div>
      )}
      {saved && (
        <div className="mb-3">
          <Alert kind="success">Direct deposit saved.</Alert>
        </div>
      )}
      {employee.payMethod !== 'direct_deposit' && (
        <p className="mb-3 text-sm text-gray-600">
          This employee is paid by check. Choose Direct deposit as the pay method to use these
          accounts.
        </p>
      )}
      <div className="space-y-3">
        {rows.map((r, i) => (
          <fieldset
            key={r.key}
            disabled={!canManage}
            className="grid gap-3 rounded-md border border-gray-200 p-3 sm:grid-cols-6"
          >
            <legend className="px-1 text-xs font-medium text-gray-600">
              Account {i + 1}{' '}
              {r.prenoteLabel && <span className="ml-2 text-gray-500">{r.prenoteLabel}</span>}
            </legend>
            <label className="text-xs text-gray-600 sm:col-span-1">
              Routing number
              <input
                aria-label={`Account ${i + 1} routing number`}
                className={cellInputClass}
                value={r.routingNumber}
                inputMode="numeric"
                onChange={(e) => set(i, { routingNumber: e.target.value })}
              />
              {fe(i, 'routingNumber') && (
                <span className="text-red-600">{fe(i, 'routingNumber')}</span>
              )}
            </label>
            <label className="text-xs text-gray-600 sm:col-span-1">
              Account number
              <input
                aria-label={`Account ${i + 1} account number`}
                className={cellInputClass}
                value={r.accountNumber}
                autoComplete="off"
                inputMode="numeric"
                placeholder={r.accountMasked ?? ''}
                onChange={(e) => set(i, { accountNumber: e.target.value })}
              />
              {fe(i, 'accountNumber') && (
                <span className="text-red-600">{fe(i, 'accountNumber')}</span>
              )}
            </label>
            <label className="text-xs text-gray-600">
              Type
              <select
                aria-label={`Account ${i + 1} type`}
                className={cellInputClass}
                value={r.accountType}
                onChange={(e) => set(i, { accountType: e.target.value as BankAccountType })}
              >
                {BANK_ACCOUNT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t === 'checking' ? 'Checking' : 'Savings'}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-gray-600">
              Deposit
              <select
                aria-label={`Account ${i + 1} deposit`}
                className={cellInputClass}
                value={r.amountType}
                onChange={(e) => set(i, { amountType: e.target.value as DepositAmountType })}
              >
                {DEPOSIT_AMOUNT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {DEPOSIT_AMOUNT_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-gray-600">
              {r.amountType === 'percent' ? 'Percent' : 'Amount'}
              <input
                aria-label={`Account ${i + 1} amount`}
                className={cellInputClass}
                value={r.amountType === 'remainder' ? '' : r.amount}
                disabled={r.amountType === 'remainder'}
                inputMode="decimal"
                onChange={(e) => set(i, { amount: e.target.value })}
              />
              {fe(i, 'amount') && <span className="text-red-600">{fe(i, 'amount')}</span>}
            </label>
            <div className="flex flex-col justify-end gap-1 text-xs">
              <Checkbox
                label="Send prenote"
                checked={r.prenote}
                onChange={(v) => set(i, { prenote: v })}
              />
              {canManage && (
                <button
                  type="button"
                  className="text-left text-red-700 underline"
                  onClick={() => setRows(rows.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              )}
            </div>
          </fieldset>
        ))}
      </div>
      {canManage && (
        <div className="mt-3 flex justify-between gap-2">
          <Button
            variant="secondary"
            disabled={rows.length >= MAX_DEPOSIT_ACCOUNTS}
            onClick={() =>
              setRows([
                ...rows,
                {
                  key: crypto.randomUUID(),
                  routingNumber: '',
                  accountNumber: '',
                  accountType: 'checking',
                  amountType: rows.some((r) => r.amountType === 'remainder')
                    ? 'fixed'
                    : 'remainder',
                  amount: '',
                  prenote: true,
                },
              ])
            }
          >
            Add account
          </Button>
          <Button onClick={save} loading={m.busy}>
            Save direct deposit
          </Button>
        </div>
      )}
    </Section>
  );
}

// --- Recurring earnings and deductions -----------------------------------------------------------
interface ItemRow {
  key: string;
  payrollItemId: string;
  amount: string;
  percent: string;
  annualLimit: string;
  caseNumber: string;
  totalOwed: string;
}

export function PayItemsSection({ companyId, employee }: Props) {
  const canManage = useAccess(companyId).can('payroll.manage');
  const items = usePayrollItems(companyId);
  const m = usePayrollMutation(companyId);
  const [rows, setRows] = useState<ItemRow[]>(() =>
    employee.payItems.map((p) => ({
      key: p.id,
      payrollItemId: p.payrollItemId,
      amount: p.amount ?? '',
      percent: p.percent ?? '',
      annualLimit: p.annualLimit ?? '',
      caseNumber: p.caseNumber ?? '',
      totalOwed: p.totalOwed ?? '',
    })),
  );
  const [saved, setSaved] = useState(false);
  const set = (i: number, patch: Partial<ItemRow>) => {
    setSaved(false);
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  const choices = (items.data ?? []).filter(
    (i) => !['hourly', 'salary', 'overtime', 'double_time'].includes(i.kind),
  );
  const kindOf = (id: string) => items.data?.find((i) => i.id === id)?.kind;

  async function save() {
    const body = { items: rows.map(({ key: _k, ...r }) => r) };
    if (await m.run(`/employees/${employee.id}/pay-items`, 'PUT', body)) setSaved(true);
  }

  return (
    <Section
      title="Deductions, contributions and other pay"
      description="Taken on every regular paycheck: retirement plans, benefits, garnishments, commissions."
      testId="pay-items"
    >
      {m.error && (
        <div className="mb-3">
          <Alert>{errText(m.error)}</Alert>
        </div>
      )}
      {saved && (
        <div className="mb-3">
          <Alert kind="success">Saved.</Alert>
        </div>
      )}
      {rows.length === 0 && <p className="mb-3 text-sm text-gray-600">None.</p>}
      <div className="space-y-2">
        {rows.map((r, i) => {
          const kind = kindOf(r.payrollItemId);
          const withCase = kind === 'garnishment' || kind === 'loan_repayment';
          return (
            <fieldset
              key={r.key}
              disabled={!canManage}
              className="grid gap-2 rounded-md border border-gray-200 p-3 sm:grid-cols-6"
            >
              <label className="text-xs text-gray-600 sm:col-span-2">
                Item
                <select
                  aria-label={`Item ${i + 1}`}
                  className={cellInputClass}
                  value={r.payrollItemId}
                  onChange={(e) => set(i, { payrollItemId: e.target.value })}
                >
                  <option value="">Choose an item</option>
                  {(
                    [
                      'earning',
                      'pre_tax_deduction',
                      'post_tax_deduction',
                      'employer_contribution',
                    ] as const
                  ).map((cat) => (
                    <optgroup key={cat} label={PAYROLL_ITEM_CATEGORY_LABELS[cat]}>
                      {choices
                        .filter(
                          (c) => c.category === cat && (c.isActive || c.id === r.payrollItemId),
                        )
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <label className="text-xs text-gray-600">
                Amount per paycheck
                <input
                  aria-label={`Item ${i + 1} amount`}
                  className={cellInputClass}
                  value={r.amount}
                  inputMode="decimal"
                  onChange={(e) => set(i, { amount: e.target.value })}
                />
              </label>
              <label className="text-xs text-gray-600">
                or percent of gross
                <input
                  aria-label={`Item ${i + 1} percent`}
                  className={cellInputClass}
                  value={r.percent}
                  inputMode="decimal"
                  onChange={(e) => set(i, { percent: e.target.value })}
                />
              </label>
              <label className="text-xs text-gray-600">
                Annual limit
                <input
                  aria-label={`Item ${i + 1} annual limit`}
                  className={cellInputClass}
                  value={r.annualLimit}
                  inputMode="decimal"
                  onChange={(e) => set(i, { annualLimit: e.target.value })}
                />
              </label>
              <div className="flex items-end">
                {canManage && (
                  <button
                    type="button"
                    className="text-xs text-red-700 underline"
                    onClick={() => setRows(rows.filter((_, j) => j !== i))}
                  >
                    Remove
                  </button>
                )}
              </div>
              {withCase && (
                <>
                  <label className="text-xs text-gray-600 sm:col-span-2">
                    Case number
                    <input
                      aria-label={`Item ${i + 1} case number`}
                      className={cellInputClass}
                      value={r.caseNumber}
                      onChange={(e) => set(i, { caseNumber: e.target.value })}
                    />
                  </label>
                  <label className="text-xs text-gray-600">
                    Total owed
                    <input
                      aria-label={`Item ${i + 1} total owed`}
                      className={cellInputClass}
                      value={r.totalOwed}
                      inputMode="decimal"
                      onChange={(e) => set(i, { totalOwed: e.target.value })}
                    />
                  </label>
                </>
              )}
            </fieldset>
          );
        })}
      </div>
      {canManage && (
        <div className="mt-3 flex justify-between gap-2">
          <Button
            variant="secondary"
            onClick={() =>
              setRows([
                ...rows,
                {
                  key: crypto.randomUUID(),
                  payrollItemId: '',
                  amount: '',
                  percent: '',
                  annualLimit: '',
                  caseNumber: '',
                  totalOwed: '',
                },
              ])
            }
          >
            Add item
          </Button>
          <Button onClick={save} loading={m.busy}>
            Save items
          </Button>
        </div>
      )}
    </Section>
  );
}

// --- PTO ----------------------------------------------------------------------------------------
export function PtoSection({ companyId, employee }: Props) {
  const canManage = useAccess(companyId).can('payroll.manage');
  const policies = usePtoPolicies(companyId);
  const m = usePayrollMutation(companyId);
  const [rows, setRows] = useState(() => employee.pto.map((p) => ({ ...p, key: p.policyId })));
  const [saved, setSaved] = useState(false);
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => {
    setSaved(false);
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  async function save() {
    const body = { policies: rows.map(({ key: _k, ...r }) => r) };
    if (await m.run(`/employees/${employee.id}/pto`, 'PUT', body)) setSaved(true);
  }
  if ((policies.data ?? []).length === 0) {
    return (
      <Section title="Paid time off" testId="pto">
        <p className="text-sm text-gray-600">Add PTO policies in Setup to track balances.</p>
      </Section>
    );
  }
  return (
    <Section
      title="Paid time off"
      description="Policies and the hours available when payroll started here."
      testId="pto"
    >
      {m.error && (
        <div className="mb-3">
          <Alert>{errText(m.error)}</Alert>
        </div>
      )}
      {saved && (
        <div className="mb-3">
          <Alert kind="success">Saved.</Alert>
        </div>
      )}
      <div className="space-y-2">
        {rows.map((r, i) => (
          <fieldset key={r.key} disabled={!canManage} className="grid gap-2 sm:grid-cols-4">
            <label className="text-xs text-gray-600">
              Policy
              <select
                aria-label={`PTO policy ${i + 1}`}
                className={cellInputClass}
                value={r.policyId}
                onChange={(e) => set(i, { policyId: e.target.value })}
              >
                <option value="">Choose a policy</option>
                {policies.data!.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-gray-600">
              Hours available
              <input
                aria-label={`PTO policy ${i + 1} hours`}
                className={cellInputClass}
                value={r.openingBalance}
                inputMode="decimal"
                onChange={(e) => set(i, { openingBalance: e.target.value })}
              />
            </label>
            <label className="text-xs text-gray-600">
              As of
              <input
                aria-label={`PTO policy ${i + 1} as of`}
                type="date"
                className={cellInputClass}
                value={r.openingAsOf}
                onChange={(e) => set(i, { openingAsOf: e.target.value })}
              />
            </label>
            <div className="flex items-end">
              {canManage && (
                <button
                  type="button"
                  className="text-xs text-red-700 underline"
                  onClick={() => setRows(rows.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              )}
            </div>
          </fieldset>
        ))}
      </div>
      {canManage && (
        <div className="mt-3 flex justify-between gap-2">
          <Button
            variant="secondary"
            onClick={() =>
              setRows([
                ...rows,
                {
                  key: crypto.randomUUID(),
                  policyId: '',
                  openingBalance: '0',
                  openingAsOf: employee.hireDate,
                },
              ])
            }
          >
            Add policy
          </Button>
          <Button onClick={save} loading={m.busy}>
            Save PTO
          </Button>
        </div>
      )}
    </Section>
  );
}
