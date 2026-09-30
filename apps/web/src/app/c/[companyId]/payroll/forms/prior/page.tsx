'use client';

import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  PAYROLL_STATES,
  PRIOR_DEPOSIT_AGENCIES,
  PRIOR_DEPOSIT_AGENCY_LABELS,
  PAYROLL_TAX_CODES,
  PAYROLL_TAX_LABELS,
  PAYROLL_TAX_STATES,
  formatDate,
  type PayrollTaxCode,
  type PriorPayrollDto,
  type PriorTaxDepositDto,
} from '@acct/shared';
import { usd } from '@/components/payroll/pay-run-ui';
import {
  errText,
  formField,
  Section,
  Select,
  Table,
  usePayrollMutation,
} from '@/components/payroll/payroll-ui';
import { PayrollSetupCard } from '@/components/payroll/setup-card';
import { FormsNav, Muted, PeriodPicker, YEARS } from '@/components/payroll/tax-forms-ui';
import { Alert, Badge, Button, Dialog, Spinner, TextInput } from '@/components/ui';
import {
  useAccess,
  useEmployees,
  usePayrollItems,
  usePayrollSettings,
  usePriorDeposits,
  usePriorPayroll,
} from '@/lib/queries';

interface ItemRow {
  payrollItemId: string;
  amount: string;
}
interface TaxRow {
  taxCode: PayrollTaxCode;
  state: string;
  taxableWages: string;
  subjectWages: string;
  amount: string;
}
const blankTax = (taxCode: PayrollTaxCode = 'federal_income'): TaxRow => ({
  taxCode,
  state: '',
  taxableWages: '',
  subjectWages: '',
  amount: '',
});

export default function PriorPayrollPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const access = useAccess(companyId);
  const settings = usePayrollSettings(companyId);
  const [year, setYear] = useState(YEARS[0]!);
  const prior = usePriorPayroll(companyId, year);
  const m = usePayrollMutation(companyId);
  const [editing, setEditing] = useState<PriorPayrollDto | 'new' | null>(null);

  if (settings.isPending || prior.isPending) return <Spinner />;
  const s = settings.data?.settings;
  if (!s) return <PayrollSetupCard companyId={companyId} />;
  const manage = access.can('payroll.manage');
  return (
    <>
      <FormsNav companyId={companyId} />
      <PeriodPicker year={year} setYear={setYear} />
      <Section
        title="Prior payroll"
        description={
          s.payrollStartDate
            ? `Pay from before your first payroll here (${formatDate(s.payrollStartDate)}), so wage bases, limits and the tax forms include it. It isn't posted to the books.`
            : 'Enter the date of your first payroll here in Payroll › Setup first.'
        }
        actions={
          manage && s.payrollStartDate ? (
            <Button
              size="sm"
              onClick={() => {
                m.setError(null);
                setEditing('new');
              }}
            >
              Add prior payroll
            </Button>
          ) : undefined
        }
        testId="prior-payroll"
      >
        {m.error && !editing && <Alert>{errText(m.error)}</Alert>}
        {(prior.data ?? []).length === 0 ? (
          <Muted>No prior payroll for {year}.</Muted>
        ) : (
          <Table
            label="Prior payroll"
            headers={['Pay date', 'Employee', 'Gross pay', 'Employee taxes', 'Company taxes', '']}
          >
            {prior.data!.map((p) => (
              <tr key={p.id}>
                <td className="px-2 py-2">{formatDate(p.payDate)}</td>
                <td className="px-2 py-2">
                  {p.employeeName}
                  {p.memo && <p className="text-xs text-gray-500">{p.memo}</p>}
                </td>
                <td className="px-2 py-2">{usd(p.grossPay)}</td>
                <td className="px-2 py-2">{usd(p.employeeTaxes)}</td>
                <td className="px-2 py-2">{usd(p.employerTaxes)}</td>
                <td className="px-2 py-2 text-right">
                  {p.lockedBy ? (
                    <Badge tone="gray">{p.lockedBy} filed</Badge>
                  ) : (
                    manage && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            if (window.confirm('Delete this prior payroll?'))
                              void m.run(`/prior-payroll/${p.id}`, 'DELETE');
                          }}
                        >
                          Delete
                        </Button>
                      </>
                    )
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
      {s.payrollStartDate && <PriorDeposits companyId={companyId} year={year} manage={manage} />}
      {editing && (
        <PriorEditor
          companyId={companyId}
          value={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function PriorEditor({
  companyId,
  value,
  onClose,
}: {
  companyId: string;
  value: PriorPayrollDto | null;
  onClose: () => void;
}) {
  const employees = useEmployees(companyId, 'all');
  const items = usePayrollItems(companyId);
  const m = usePayrollMutation(companyId);
  const [itemRows, setItemRows] = useState<ItemRow[]>(
    value?.items.map((i) => ({ payrollItemId: i.payrollItemId, amount: i.amount })) ?? [
      { payrollItemId: '', amount: '' },
    ],
  );
  const [taxRows, setTaxRows] = useState<TaxRow[]>(
    value?.taxes.map((t) => ({
      taxCode: t.taxCode,
      state: t.state ?? '',
      taxableWages: t.taxableWages,
      subjectWages: t.subjectWages === t.taxableWages ? '' : t.subjectWages,
      amount: t.amount,
    })) ?? [
      blankTax('federal_income'),
      blankTax('social_security_employee'),
      blankTax('social_security_employer'),
      blankTax('medicare_employee'),
      blankTax('medicare_employer'),
      blankTax('futa'),
    ],
  );

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ok = await m.run(
      value ? `/prior-payroll/${value.id}` : '/prior-payroll',
      value ? 'PUT' : 'POST',
      {
        employeeId: formField(f, 'employeeId'),
        payDate: formField(f, 'payDate'),
        memo: formField(f, 'memo'),
        items: itemRows.filter((r) => r.payrollItemId && r.amount),
        taxes: taxRows
          .filter((r) => r.amount !== '' || r.taxableWages !== '')
          .map((r) => ({
            taxCode: r.taxCode,
            state: PAYROLL_TAX_STATES[r.taxCode] === 'any' ? r.state || null : null,
            taxableWages: r.taxableWages || '0',
            subjectWages: r.subjectWages || null,
            amount: r.amount || '0',
          })),
      },
    );
    if (ok) onClose();
  }

  const setItem = (i: number, patch: Partial<ItemRow>) =>
    setItemRows((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setTax = (i: number, patch: Partial<TaxRow>) =>
    setTaxRows((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Dialog open onClose={onClose} title={value ? 'Edit prior payroll' : 'Add prior payroll'} wide>
      <form onSubmit={submit} className="space-y-4" aria-label="Prior payroll">
        {m.error && <Alert>{errText(m.error)}</Alert>}
        <div className="grid gap-4 sm:grid-cols-3">
          <Select
            label="Employee"
            name="employeeId"
            defaultValue={value?.employeeId ?? ''}
            placeholder="Choose"
            options={(employees.data ?? []).map((e) => ({ value: e.id, label: e.displayName }))}
            error={m.fieldError('employeeId')}
          />
          <TextInput
            label="Pay date"
            name="payDate"
            type="date"
            defaultValue={value?.payDate ?? ''}
            hint="Or the last pay date of the period the totals cover."
            error={m.fieldError('payDate')}
          />
          <TextInput label="Memo" name="memo" defaultValue={value?.memo ?? ''} />
        </div>

        <fieldset>
          <legend className="text-sm font-semibold text-gray-900">
            Pay, deductions and contributions
          </legend>
          {itemRows.map((r, i) => (
            <div key={i} className="mt-2 grid gap-2 sm:grid-cols-[2fr_1fr_auto]">
              <Select
                label={`Item ${i + 1}`}
                value={r.payrollItemId}
                onChange={(e) => setItem(i, { payrollItemId: e.target.value })}
                placeholder="Choose"
                options={(items.data ?? []).map((it) => ({ value: it.id, label: it.name }))}
              />
              <TextInput
                label={`Item ${i + 1} amount`}
                value={r.amount}
                inputMode="decimal"
                onChange={(e) => setItem(i, { amount: e.target.value })}
              />
              <div className="flex items-end">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setItemRows((rows) => rows.filter((_, j) => j !== i))}
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="mt-2"
            onClick={() => setItemRows((rows) => [...rows, { payrollItemId: '', amount: '' }])}
          >
            Add item
          </Button>
        </fieldset>

        <fieldset>
          <legend className="text-sm font-semibold text-gray-900">Taxes</legend>
          <p className="text-xs text-gray-600">
            Taxable wages are the wages each tax was figured on; enter wages before the wage base
            only when they were higher. Enter federal income tax even when none was withheld, so W-2
            box 1 has its wages.
          </p>
          {taxRows.map((r, i) => (
            <div key={i} className="mt-2 grid gap-2 sm:grid-cols-[2fr_1fr_1fr_1fr_1fr_auto]">
              <Select
                label={`Tax ${i + 1}`}
                value={r.taxCode}
                onChange={(e) => setTax(i, { taxCode: e.target.value as PayrollTaxCode })}
                options={PAYROLL_TAX_CODES.map((c) => ({
                  value: c,
                  label:
                    PAYROLL_TAX_STATES[c] === 'any'
                      ? `State ${PAYROLL_TAX_LABELS[c]}`
                      : PAYROLL_TAX_LABELS[c],
                }))}
              />
              {PAYROLL_TAX_STATES[r.taxCode] === 'any' ? (
                <Select
                  label={`Tax ${i + 1} state`}
                  value={r.state}
                  onChange={(e) => setTax(i, { state: e.target.value })}
                  placeholder="State"
                  options={PAYROLL_STATES.map((s) => ({ value: s, label: s }))}
                />
              ) : (
                <div />
              )}
              <TextInput
                label={`Tax ${i + 1} taxable wages`}
                value={r.taxableWages}
                inputMode="decimal"
                onChange={(e) => setTax(i, { taxableWages: e.target.value })}
              />
              <TextInput
                label={`Tax ${i + 1} wages before the base`}
                value={r.subjectWages}
                inputMode="decimal"
                onChange={(e) => setTax(i, { subjectWages: e.target.value })}
              />
              <TextInput
                label={`Tax ${i + 1} amount`}
                value={r.amount}
                inputMode="decimal"
                onChange={(e) => setTax(i, { amount: e.target.value })}
              />
              <div className="flex items-end">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setTaxRows((rows) => rows.filter((_, j) => j !== i))}
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="mt-2"
            onClick={() => setTaxRows((rows) => [...rows, blankTax('state_income')])}
          >
            Add tax
          </Button>
        </fieldset>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={m.busy}>
            Save prior payroll
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Federal deposits the old payroll service made for quarters before the switch. */
function PriorDeposits({
  companyId,
  year,
  manage,
}: {
  companyId: string;
  year: number;
  manage: boolean;
}) {
  const deposits = usePriorDeposits(companyId, year);
  const m = usePayrollMutation(companyId);
  const [editing, setEditing] = useState<PriorTaxDepositDto | 'new' | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ok = await m.run(
      editing && editing !== 'new' ? `/prior-deposits/${editing.id}` : '/prior-deposits',
      editing && editing !== 'new' ? 'PUT' : 'POST',
      {
        agency: formField(f, 'agency'),
        taxYear: Number(formField(f, 'taxYear')),
        quarter: Number(formField(f, 'quarter')),
        paymentDate: formField(f, 'paymentDate'),
        amount: formField(f, 'amount'),
        memo: formField(f, 'memo'),
      },
    );
    if (ok) setEditing(null);
  }

  const value = editing && editing !== 'new' ? editing : null;
  return (
    <Section
      title="Deposits made before payroll here"
      description="Federal deposits your old payroll service made for quarters before the switch, so Forms 941 and 940 show everything deposited. They aren't posted to the books."
      actions={
        manage ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              m.setError(null);
              setEditing('new');
            }}
          >
            Add deposit
          </Button>
        ) : undefined
      }
      testId="prior-deposits"
    >
      {m.error && !editing && <Alert>{errText(m.error)}</Alert>}
      {(deposits.data ?? []).length === 0 ? (
        <Muted>No earlier deposits for {year}.</Muted>
      ) : (
        <Table
          label="Deposits made before payroll here"
          headers={['Paid', 'For', 'Quarter', 'Amount', '']}
        >
          {deposits.data!.map((d) => (
            <tr key={d.id}>
              <td className="px-2 py-2">{formatDate(d.paymentDate)}</td>
              <td className="px-2 py-2">
                {d.agencyLabel}
                {d.memo && <p className="text-xs text-gray-500">{d.memo}</p>}
              </td>
              <td className="px-2 py-2">
                Q{d.quarter} {d.taxYear}
              </td>
              <td className="px-2 py-2">{usd(d.amount)}</td>
              <td className="px-2 py-2 text-right">
                {d.lockedBy ? (
                  <Badge tone="gray">{d.lockedBy} filed</Badge>
                ) : (
                  manage && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(d)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          if (window.confirm('Delete this deposit?'))
                            void m.run(`/prior-deposits/${d.id}`, 'DELETE');
                        }}
                      >
                        Delete
                      </Button>
                    </>
                  )
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {editing && (
        <Dialog
          open
          onClose={() => setEditing(null)}
          title={value ? 'Edit deposit' : 'Add a deposit made before payroll here'}
        >
          <form onSubmit={submit} className="space-y-4" aria-label="Earlier deposit">
            {m.error && <Alert>{errText(m.error)}</Alert>}
            <Select
              label="Deposit for"
              name="agency"
              defaultValue={value?.agency ?? 'federal_941'}
              options={PRIOR_DEPOSIT_AGENCIES.map((a) => ({
                value: a,
                label: PRIOR_DEPOSIT_AGENCY_LABELS[a],
              }))}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Select
                label="Tax year"
                name="taxYear"
                defaultValue={String(value?.taxYear ?? year)}
                options={YEARS.map((y) => ({ value: String(y), label: String(y) }))}
              />
              <Select
                label="Quarter"
                name="quarter"
                defaultValue={String(value?.quarter ?? 1)}
                options={[1, 2, 3, 4].map((q) => ({ value: String(q), label: `Q${q}` }))}
                error={m.fieldError('quarter')}
              />
            </div>
            <TextInput
              label="Payment date"
              name="paymentDate"
              type="date"
              defaultValue={value?.paymentDate ?? ''}
              error={m.fieldError('paymentDate')}
            />
            <TextInput
              label="Amount"
              name="amount"
              inputMode="decimal"
              defaultValue={value?.amount ?? ''}
              error={m.fieldError('amount')}
            />
            <TextInput label="Memo" name="memo" defaultValue={value?.memo ?? ''} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit" loading={m.busy}>
                Save deposit
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </Section>
  );
}
