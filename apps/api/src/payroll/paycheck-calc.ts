import {
  PAY_PERIODS_PER_YEAR,
  PAYROLL_ITEM_KINDS,
  ZERO,
  moneyToString,
  parseMoney,
  type Money,
  type PayFrequency,
  type PayrollItemKind,
  type PayrollState,
  type PayrollTaxCode,
} from '@acct/shared';
import { dec, div, mul, q, toCents } from './tax/rational';
import type { PayrollTaxData } from './tax/tax-data-types';
import {
  TaxCalculationRefused,
  calculatePaycheckTaxes,
  type StateCertificateFacts,
  type W4Facts,
  type YtdWages,
} from './tax/tax-engine';

/**
 * Builds one paycheck from what the payroll admin entered, the employee's recurring items and
 * the tax engine. Pure: the pay run service loads the facts and stores the result.
 */

export interface PaycheckInputFacts {
  earnings: {
    payrollItemId: string;
    hours: string | null;
    rate: string | null;
    amount: string | null;
  }[];
  /** Amounts that replace a recurring item for this paycheck ("0" skips it) or add an item. */
  deductions: { payrollItemId: string; amount: string }[];
  contributions: { payrollItemId: string; amount: string }[];
}

export interface ItemFacts {
  id: string;
  name: string;
  kind: PayrollItemKind;
  rateMultiplier: string | null;
}

export interface RecurringFacts {
  payrollItemId: string;
  amount: string | null;
  percent: string | null;
  /** What's left under the employee's annual limit or a garnishment's total owed. */
  remaining: Money | null;
}

export interface PaycheckFacts {
  payDate: string;
  taxData: PayrollTaxData | null;
  taxYear: number;
  frequency: PayFrequency;
  workState: PayrollState;
  stateRegistered: boolean;
  w4: W4Facts | null;
  stateCertificate: StateCertificateFacts | null;
  firstPaidBefore2020: boolean;
  supplemental: boolean;
  employee: {
    payType: 'hourly' | 'salary' | 'commission';
    payRate: string;
    defaultHours: string | null;
  };
  items: Map<string, ItemFacts>;
  input: PaycheckInputFacts;
  recurring: RecurringFacts[];
  ytd: YtdWages;
  unemploymentRatePercent: string | null;
  payMethod: 'check' | 'direct_deposit';
  hasDepositAccounts: boolean;
}

export interface LineDraft {
  lineType: 'earning' | 'deduction' | 'contribution' | 'tax';
  payrollItemId: string | null;
  taxCode: PayrollTaxCode | null;
  payer: 'employee' | 'employer' | null;
  state: string | null;
  hours: string | null;
  rate: string | null;
  amount: Money;
  taxableWages: Money | null;
  description: string | null;
}

export interface PaycheckResult {
  lines: LineDraft[];
  grossPay: Money;
  employeeTaxes: Money;
  deductions: Money;
  netPay: Money;
  employerTaxes: Money;
  contributions: Money;
  problems: string[];
  notices: string[];
}

/** The employee's regular hourly rate: the hourly rate, or a salary spread over usual hours. */
export function baseHourlyRate(
  employee: PaycheckFacts['employee'],
  frequency: PayFrequency,
): string | null {
  if (employee.payType === 'hourly') return employee.payRate;
  if (employee.payType === 'salary' && employee.defaultHours && dec(employee.defaultHours).n > 0n) {
    const perPeriod = div(dec(employee.payRate), q(BigInt(PAY_PERIODS_PER_YEAR[frequency])));
    const hourly = div(perPeriod, dec(employee.defaultHours));
    // Rates are kept to four decimals.
    return moneyToString(roundTo4(hourly), 4);
  }
  return null;
}

function roundTo4(v: ReturnType<typeof dec>): Money {
  const neg = v.n < 0n;
  const n = neg ? -v.n : v.n;
  const units = (2n * n * 10_000n + v.d) / (2n * v.d);
  return neg ? -units : units;
}

/** One period's salary: the annual salary divided by the pay periods in a year, to the cent. */
export function salaryForPeriod(annual: string, frequency: PayFrequency): Money {
  return toCents(div(dec(annual), q(BigInt(PAY_PERIODS_PER_YEAR[frequency]))));
}

export function buildPaycheck(f: PaycheckFacts): PaycheckResult {
  const problems: string[] = [];
  const notices: string[] = [];
  const lines: LineDraft[] = [];
  const itemLine = (
    lineType: LineDraft['lineType'],
    item: ItemFacts,
    amount: Money,
    hours: string | null = null,
    rate: string | null = null,
  ): LineDraft => ({
    lineType,
    payrollItemId: item.id,
    taxCode: null,
    payer: null,
    state: null,
    hours,
    rate,
    amount,
    taxableWages: null,
    description: item.name,
  });

  // Earnings.
  const base = baseHourlyRate(f.employee, f.frequency);
  for (const e of f.input.earnings) {
    const item = f.items.get(e.payrollItemId);
    if (!item || PAYROLL_ITEM_KINDS[item.kind].category !== 'earning') {
      problems.push('An earning line names an item that is not an active earnings item.');
      continue;
    }
    if (e.hours !== null && e.hours !== '') {
      let rate = e.rate;
      if (!rate && base) {
        rate = item.rateMultiplier
          ? moneyToString(roundTo4(mul(dec(base), dec(item.rateMultiplier))), 4)
          : base;
      }
      if (!rate) {
        problems.push(`${item.name}: enter a rate for the hours.`);
        continue;
      }
      lines.push(itemLine('earning', item, toCents(mul(dec(e.hours), dec(rate))), e.hours, rate));
    } else if (e.amount) {
      lines.push(itemLine('earning', item, parseMoney(e.amount)));
    }
  }
  const gross = sum(lines.map((l) => l.amount));
  // Percentages apply to pay for work, not to expense reimbursements.
  const percentBase = sum(
    lines
      .filter((l) => f.items.get(l.payrollItemId!)?.kind !== 'reimbursement')
      .map((l) => l.amount),
  );

  // Deductions and company contributions: recurring items, replaced or added to by the input.
  for (const lineType of ['deduction', 'contribution'] as const) {
    const entered = lineType === 'deduction' ? f.input.deductions : f.input.contributions;
    const wanted =
      lineType === 'deduction'
        ? ['pre_tax_deduction', 'post_tax_deduction']
        : ['employer_contribution'];
    const overrides = new Map(entered.map((d) => [d.payrollItemId, d.amount]));
    for (const r of f.recurring) {
      const item = f.items.get(r.payrollItemId);
      if (!item || !wanted.includes(PAYROLL_ITEM_KINDS[item.kind].category)) continue;
      let amount: Money;
      if (overrides.has(r.payrollItemId)) {
        amount = parseMoney(overrides.get(r.payrollItemId)!);
        overrides.delete(r.payrollItemId);
      } else if (r.percent !== null) {
        amount = toCents(mul(dec(moneyToString(percentBase, 2)), div(dec(r.percent), q(100n))));
      } else {
        amount = parseMoney(r.amount ?? '0');
      }
      if (r.remaining !== null && amount > r.remaining) {
        amount = r.remaining > ZERO ? r.remaining : ZERO;
        notices.push(`${item.name} stops at its limit.`);
      }
      if (amount > ZERO) lines.push(itemLine(lineType, item, amount));
    }
    for (const [itemId, amountText] of overrides) {
      const item = f.items.get(itemId);
      if (!item || !wanted.includes(PAYROLL_ITEM_KINDS[item.kind].category)) {
        problems.push(`A ${lineType} line names an item that is not an active ${lineType} item.`);
        continue;
      }
      const amount = parseMoney(amountText);
      if (amount > ZERO) lines.push(itemLine(lineType, item, amount));
    }
  }
  const deductions = sum(lines.filter((l) => l.lineType === 'deduction').map((l) => l.amount));
  const contributions = sum(
    lines.filter((l) => l.lineType === 'contribution').map((l) => l.amount),
  );

  // Taxes.
  let employeeTaxes = ZERO;
  let employerTaxes = ZERO;
  if (gross === ZERO)
    problems.push(
      'There is no pay on this paycheck. Enter pay, or remove the employee from the run.',
    );
  if (!f.stateRegistered)
    problems.push(`Add ${f.workState} under Payroll › Setup › States (the employee works there).`);
  if (!f.taxData) {
    problems.push(`There is no ${f.taxYear} payroll tax data yet.`);
  } else if (gross > ZERO && f.stateRegistered) {
    try {
      const taxes = calculatePaycheckTaxes(f.taxData, {
        payDate: f.payDate,
        frequency: f.frequency,
        workState: f.workState,
        w4: f.w4,
        firstPaidBefore2020: f.firstPaidBefore2020,
        stateCertificate: f.stateCertificate,
        items: lines
          .filter((l) => l.lineType !== 'tax')
          .map((l) => ({ kind: f.items.get(l.payrollItemId!)!.kind, amount: l.amount })),
        supplemental: f.supplemental,
        ytd: f.ytd,
        unemploymentRatePercent: f.unemploymentRatePercent,
      });
      notices.push(...taxes.notices);
      for (const t of taxes.lines) {
        lines.push({
          lineType: 'tax',
          payrollItemId: null,
          taxCode: t.code,
          payer: t.payer,
          state: t.state,
          hours: null,
          rate: null,
          amount: t.amount,
          taxableWages: t.taxableWages,
          description: null,
        });
        if (t.payer === 'employee') employeeTaxes += t.amount;
        else employerTaxes += t.amount;
      }
    } catch (e) {
      if (!(e instanceof TaxCalculationRefused)) throw e;
      problems.push(...e.reasons);
    }
  }

  const netPay = gross - employeeTaxes - deductions;
  if (netPay < ZERO) problems.push('Taxes and deductions are more than the pay.');
  if (f.payMethod === 'direct_deposit' && !f.hasDepositAccounts)
    problems.push(
      'Paid by direct deposit, but there is no deposit account. Add one or pay by check.',
    );

  return {
    lines,
    grossPay: gross,
    employeeTaxes,
    deductions,
    netPay: netPay < ZERO ? ZERO : netPay,
    employerTaxes,
    contributions,
    problems,
    notices,
  };
}

function sum(values: Money[]): Money {
  return values.reduce((a, b) => a + b, ZERO);
}
