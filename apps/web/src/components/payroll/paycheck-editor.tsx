'use client';

import { useState, type FormEvent } from 'react';
import {
  PAYROLL_ITEM_KINDS,
  type PaycheckDto,
  type PayrollItemDto,
  type PayRunDto,
} from '@acct/shared';
import {
  cellInputClass,
  errText,
  selectClass,
  usePayrollMutation,
} from '@/components/payroll/payroll-ui';
import { usd } from '@/components/payroll/pay-run-ui';
import { Alert, Button, Dialog, Spinner } from '@/components/ui';
import { usePaycheck } from '@/lib/queries';

interface EarningRow {
  payrollItemId: string;
  hours: string;
  rate: string;
  amount: string;
}
interface AmountRow {
  payrollItemId: string;
  /** Empty: calculated from the employee's recurring item. */
  amount: string;
}

/** Edits a draft paycheck: earnings, and amounts that replace or skip recurring deductions. */
export function PaycheckEditor({
  companyId,
  runId,
  paycheckId,
  items,
  onClose,
}: {
  companyId: string;
  runId: string;
  paycheckId: string;
  items: PayrollItemDto[];
  onClose: () => void;
}) {
  const paycheck = usePaycheck(companyId, paycheckId);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Edit paycheck${paycheck.data ? `: ${paycheck.data.employeeName}` : ''}`}
      wide
    >
      {paycheck.data ? (
        <EditorForm
          companyId={companyId}
          runId={runId}
          paycheck={paycheck.data}
          items={items}
          onClose={onClose}
        />
      ) : (
        <Spinner />
      )}
    </Dialog>
  );
}

function EditorForm({
  companyId,
  runId,
  paycheck,
  items,
  onClose,
}: {
  companyId: string;
  runId: string;
  paycheck: PaycheckDto;
  items: PayrollItemDto[];
  onClose: () => void;
}) {
  const m = usePayrollMutation(companyId);
  const active = items.filter((i) => i.isActive);
  const ofCategory = (c: string) => active.filter((i) => PAYROLL_ITEM_KINDS[i.kind].category === c);
  const earningItems = ofCategory('earning');
  const deductionItems = [...ofCategory('pre_tax_deduction'), ...ofCategory('post_tax_deduction')];
  const contributionItems = ofCategory('employer_contribution');

  const [earnings, setEarnings] = useState<EarningRow[]>(
    paycheck.input.earnings.map((e) => ({
      payrollItemId: e.payrollItemId,
      hours: e.hours ?? '',
      rate: e.rate ?? '',
      amount: e.amount ?? '',
    })),
  );
  // Current deduction and contribution lines, with any entered override.
  const initial = (type: 'deduction' | 'contribution'): AmountRow[] => {
    const entered = type === 'deduction' ? paycheck.input.deductions : paycheck.input.contributions;
    const ids = [
      ...new Set([
        ...paycheck.lines.filter((l) => l.lineType === type).map((l) => l.payrollItemId!),
        ...entered.map((d) => d.payrollItemId),
      ]),
    ];
    return ids.map((id) => ({
      payrollItemId: id,
      amount: entered.find((d) => d.payrollItemId === id)?.amount ?? '',
    }));
  };
  const [deductions, setDeductions] = useState<AmountRow[]>(initial('deduction'));
  const [contributions, setContributions] = useState<AmountRow[]>(initial('contribution'));
  const current = (id: string) =>
    paycheck.lines.find((l) => l.payrollItemId === id && l.lineType !== 'earning');

  async function save(e: FormEvent) {
    e.preventDefault();
    const result = await m.run<PayRunDto>(`/pay-runs/${runId}/paychecks/${paycheck.id}`, 'PUT', {
      earnings: earnings
        .filter((r) => r.payrollItemId && (r.hours || r.amount))
        .map((r) => ({
          payrollItemId: r.payrollItemId,
          hours: r.hours || null,
          rate: r.hours ? r.rate || null : null,
          amount: r.hours ? null : r.amount,
        })),
      deductions: deductions.filter((r) => r.payrollItemId && r.amount !== ''),
      contributions: contributions.filter((r) => r.payrollItemId && r.amount !== ''),
    });
    if (result) onClose();
  }

  const itemSelect = (
    value: string,
    options: PayrollItemDto[],
    onChange: (v: string) => void,
    label: string,
  ) => (
    <select
      className={selectClass}
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Choose…</option>
      {options.map((i) => (
        <option key={i.id} value={i.id}>
          {i.name}
        </option>
      ))}
    </select>
  );

  const amountRows = (
    title: string,
    rows: AmountRow[],
    set: (r: AmountRow[]) => void,
    options: PayrollItemDto[],
  ) => (
    <fieldset className="mt-5">
      <legend className="text-sm font-semibold text-gray-900">{title}</legend>
      <p className="mb-2 text-xs text-gray-600">
        Leave an amount empty to use the employee&apos;s recurring amount; enter 0 to skip it on
        this paycheck.
      </p>
      {rows.map((r, i) => {
        const now = current(r.payrollItemId);
        return (
          <div key={i} className="mb-2 grid grid-cols-[2fr_1fr_auto] items-center gap-2">
            {itemSelect(
              r.payrollItemId,
              options,
              (v) => set(rows.map((x, j) => (j === i ? { ...x, payrollItemId: v } : x))),
              `${title} ${i + 1} item`,
            )}
            <input
              className={cellInputClass}
              aria-label={`${title} ${i + 1} amount`}
              placeholder={now ? `${usd(now.amount)} (recurring)` : 'Amount'}
              value={r.amount}
              onChange={(e) =>
                set(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => set(rows.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          </div>
        );
      })}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => set([...rows, { payrollItemId: '', amount: '' }])}
      >
        Add {title.toLowerCase().replace(/s$/, '')}
      </Button>
    </fieldset>
  );

  return (
    <form onSubmit={save} aria-label="Paycheck">
      {m.error && (
        <div className="mb-3">
          <Alert>{errText(m.error)}</Alert>
        </div>
      )}
      <fieldset>
        <legend className="text-sm font-semibold text-gray-900">Earnings</legend>
        <p className="mb-2 text-xs text-gray-600">
          Hours use the employee&apos;s rate (overtime at its multiple) unless you enter a rate. Or
          enter an amount.
        </p>
        <div className="mb-1 grid grid-cols-[2fr_1fr_1fr_1fr_auto] gap-2 text-xs font-medium uppercase text-gray-500">
          <span>Item</span>
          <span>Hours</span>
          <span>Rate</span>
          <span>Amount</span>
          <span />
        </div>
        {earnings.map((r, i) => {
          const set = (patch: Partial<EarningRow>) =>
            setEarnings(earnings.map((x, j) => (j === i ? { ...x, ...patch } : x)));
          return (
            <div key={i} className="mb-2 grid grid-cols-[2fr_1fr_1fr_1fr_auto] items-center gap-2">
              {itemSelect(
                r.payrollItemId,
                earningItems,
                (v) => set({ payrollItemId: v }),
                `Earning ${i + 1} item`,
              )}
              <input
                className={cellInputClass}
                aria-label={`Earning ${i + 1} hours`}
                value={r.hours}
                onChange={(e) => set({ hours: e.target.value })}
              />
              <input
                className={cellInputClass}
                aria-label={`Earning ${i + 1} rate`}
                placeholder="Usual"
                value={r.rate}
                disabled={!r.hours}
                onChange={(e) => set({ rate: e.target.value })}
              />
              <input
                className={cellInputClass}
                aria-label={`Earning ${i + 1} amount`}
                value={r.amount}
                disabled={!!r.hours}
                onChange={(e) => set({ amount: e.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setEarnings(earnings.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            </div>
          );
        })}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() =>
            setEarnings([...earnings, { payrollItemId: '', hours: '', rate: '', amount: '' }])
          }
        >
          Add earning
        </Button>
      </fieldset>
      {amountRows('Deductions', deductions, setDeductions, deductionItems)}
      {amountRows('Company contributions', contributions, setContributions, contributionItems)}
      <div className="mt-6 flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" loading={m.busy}>
          Save and recalculate
        </Button>
      </div>
    </form>
  );
}
