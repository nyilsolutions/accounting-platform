import { moneyToString, type PayrollItemKind } from '@acct/shared';
import { describe, expect, it } from 'vitest';
import {
  baseHourlyRate,
  buildPaycheck,
  salaryForPeriod,
  type ItemFacts,
  type PaycheckFacts,
} from './paycheck-calc';
import { loadPayrollTaxData } from './tax/tax-data-types';
import { NO_YTD } from './tax/tax-engine';

const taxData = loadPayrollTaxData(2026)!;
const kinds: [string, PayrollItemKind, string | null][] = [
  ['hourly', 'hourly', null],
  ['ot', 'overtime', '1.5'],
  ['salary', 'salary', null],
  ['vacation', 'vacation', null],
  ['reimb', 'reimbursement', null],
  ['k401', 'traditional_401k', null],
  ['loan', 'loan_repayment', null],
  ['match', 'retirement_match', null],
];
const items = new Map<string, ItemFacts>(
  kinds.map(([id, kind, m]) => [id, { id, name: id, kind, rateMultiplier: m }]),
);

function facts(over: Partial<PaycheckFacts> = {}): PaycheckFacts {
  return {
    taxData,
    taxYear: 2026,
    frequency: 'weekly',
    workState: 'TX',
    stateRegistered: true,
    w4: null,
    stateCertificate: null,
    firstPaidBefore2020: false,
    supplemental: false,
    employee: { payType: 'hourly', payRate: '20', defaultHours: '40' },
    items,
    input: { earnings: [], deductions: [], contributions: [] },
    recurring: [],
    ytd: NO_YTD,
    unemploymentRatePercent: '2.7',
    payMethod: 'check',
    hasDepositAccounts: false,
    ...over,
  };
}
const m = (v: bigint) => moneyToString(v);

describe('rates and salary', () => {
  it('an hourly employee keeps their rate; a salary is spread over usual hours', () => {
    expect(baseHourlyRate({ payType: 'hourly', payRate: '20', defaultHours: '40' }, 'weekly')).toBe(
      '20',
    );
    // $52,000 / 52 = $1,000 a week over 40 hours.
    expect(
      baseHourlyRate({ payType: 'salary', payRate: '52000', defaultHours: '40' }, 'weekly'),
    ).toBe('25.0000');
    expect(
      baseHourlyRate({ payType: 'salary', payRate: '52000', defaultHours: null }, 'weekly'),
    ).toBeNull();
    expect(
      baseHourlyRate({ payType: 'commission', payRate: '0', defaultHours: '40' }, 'weekly'),
    ).toBeNull();
  });

  it("one period's salary is the annual amount over the periods in a year, to the cent", () => {
    expect(m(salaryForPeriod('50000', 'semimonthly'))).toBe('2083.33');
    expect(m(salaryForPeriod('50000', 'biweekly'))).toBe('1923.08');
    expect(m(salaryForPeriod('50000', 'monthly'))).toBe('4166.67');
  });
});

describe('a paycheck', () => {
  it('hours at the rate, overtime at the multiple, amounts as entered', () => {
    const r = buildPaycheck(
      facts({
        input: {
          earnings: [
            { payrollItemId: 'hourly', hours: '40', rate: null, amount: null },
            { payrollItemId: 'ot', hours: '2.5', rate: null, amount: null },
            { payrollItemId: 'reimb', hours: null, rate: null, amount: '12.34' },
          ],
          deductions: [],
          contributions: [],
        },
      }),
    );
    const earnings = r.lines.filter((l) => l.lineType === 'earning');
    expect(earnings.map((l) => [l.description, l.hours, l.rate, m(l.amount)])).toEqual([
      ['hourly', '40', '20', '800.00'],
      ['ot', '2.5', '30.0000', '75.00'],
      ['reimb', null, null, '12.34'],
    ]);
    expect(m(r.grossPay)).toBe('887.34');
    // Texas hasn't sourced how reimbursements count for unemployment, so taxes are refused
    // (the federal treatment is covered by the tax engine tests).
    expect(r.problems).toEqual([
      "Texas unemployment tax: the treatment of Expense reimbursement isn't sourced yet.",
    ]);
    expect(m(r.netPay)).toBe(m(r.grossPay - r.employeeTaxes - r.deductions));
  });

  it('percentages apply to pay for work (not reimbursements) and stop at the remaining limit', () => {
    const r = buildPaycheck(
      facts({
        workState: 'FL',
        input: {
          earnings: [
            { payrollItemId: 'hourly', hours: '40', rate: null, amount: null },
            { payrollItemId: 'reimb', hours: null, rate: null, amount: '100' },
          ],
          deductions: [],
          contributions: [],
        },
        recurring: [
          { payrollItemId: 'loan', amount: '500', percent: null, remaining: 25_0000n * 10n },
          { payrollItemId: 'match', amount: null, percent: '3', remaining: null },
        ],
      }),
    );
    expect(
      r.lines
        .filter((l) => l.lineType !== 'tax' && l.lineType !== 'earning')
        .map((l) => [l.description, m(l.amount)]),
    ).toEqual([
      ['loan', '250.00'],
      ['match', '24.00'],
    ]);
    expect(r.notices).toContain('loan stops at its limit.');
  });

  it('an entered amount replaces a recurring item, and "0" skips it', () => {
    const r = buildPaycheck(
      facts({
        input: {
          earnings: [{ payrollItemId: 'hourly', hours: '40', rate: null, amount: null }],
          deductions: [{ payrollItemId: 'loan', amount: '0' }],
          contributions: [{ payrollItemId: 'match', amount: '10' }],
        },
        recurring: [
          { payrollItemId: 'loan', amount: '50', percent: null, remaining: null },
          { payrollItemId: 'match', amount: null, percent: '3', remaining: null },
        ],
      }),
    );
    expect(r.lines.filter((l) => l.lineType === 'deduction')).toEqual([]);
    expect(m(r.contributions)).toBe('10.00');
  });

  it('collects every problem instead of stopping at the first', () => {
    const r = buildPaycheck(
      facts({
        employee: { payType: 'commission', payRate: '0', defaultHours: null },
        stateRegistered: false,
        payMethod: 'direct_deposit',
        input: {
          earnings: [{ payrollItemId: 'hourly', hours: '10', rate: null, amount: null }],
          deductions: [{ payrollItemId: 'hourly', amount: '5' }],
          contributions: [],
        },
      }),
    );
    expect(r.problems).toEqual([
      'hourly: enter a rate for the hours.',
      'A deduction line names an item that is not an active deduction item.',
      'There is no pay on this paycheck. Enter pay, or remove the employee from the run.',
      'Add TX under Payroll › Setup › States (the employee works there).',
      'Paid by direct deposit, but there is no deposit account. Add one or pay by check.',
    ]);
  });

  it('refuses when deductions are more than the pay, and without tax data for the year', () => {
    const over = buildPaycheck(
      facts({
        input: {
          earnings: [{ payrollItemId: 'hourly', hours: '1', rate: null, amount: null }],
          deductions: [{ payrollItemId: 'loan', amount: '100' }],
          contributions: [],
        },
      }),
    );
    expect(over.problems).toContain('Taxes and deductions are more than the pay.');
    expect(over.netPay).toBe(0n);
    const noData = buildPaycheck(
      facts({
        taxData: null,
        taxYear: 2027,
        input: {
          earnings: [{ payrollItemId: 'hourly', hours: '1', rate: null, amount: null }],
          deductions: [],
          contributions: [],
        },
      }),
    );
    expect(noData.problems).toEqual(['There is no 2027 payroll tax data yet.']);
  });
});
