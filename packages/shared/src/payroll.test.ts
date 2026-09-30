import { describe, expect, it } from 'vitest';
import {
  bankAccountsInputSchema,
  employeeInputSchema,
  employeePayItemsInputSchema,
  isValidRoutingNumber,
  payDateFor,
  payPeriods,
  payrollItemInputSchema,
  payScheduleInputSchema,
  ptoPolicyInputSchema,
  ssnSchema,
  stateCertificateInputSchema,
  unemploymentRateInputSchema,
  w4InputSchema,
} from './payroll';

const SCHEDULE = '00000000-0000-4000-8000-000000000001';

describe('SSNs and routing numbers', () => {
  it('normalizes SSNs and rejects numbers SSA never issues', () => {
    expect(ssnSchema.parse('123-45-6789')).toBe('123456789');
    for (const bad of [
      '000-12-3456',
      '666-12-3456',
      '900-12-3456',
      '123-00-4567',
      '123-45-0000',
      '12345678',
    ]) {
      expect(ssnSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('checks the ABA check digit', () => {
    expect(isValidRoutingNumber('021000021')).toBe(true);
    expect(isValidRoutingNumber('011000015')).toBe(true);
    expect(isValidRoutingNumber('021000022')).toBe(false);
    expect(isValidRoutingNumber('02100002')).toBe(false);
  });
});

describe('pay periods', () => {
  it('weekly and biweekly periods step from the anchor', () => {
    const s = { frequency: 'biweekly' as const, firstPeriodEnd: '2026-01-09', payDateOffset: 5 };
    expect(payPeriods(s, '2026-01-10', 2)).toEqual([
      { start: '2026-01-10', end: '2026-01-23', payDate: '2026-01-28' },
      { start: '2026-01-24', end: '2026-02-06', payDate: '2026-02-11' },
    ]);
    // Anchors in the future work backwards too.
    const w = { frequency: 'weekly' as const, firstPeriodEnd: '2026-06-05', payDateOffset: 0 };
    expect(payPeriods(w, '2026-05-27', 1)[0]).toEqual({
      start: '2026-05-23',
      end: '2026-05-29',
      payDate: '2026-05-29',
    });
  });

  it('semimonthly periods end on the 15th and the last day', () => {
    const s = { frequency: 'semimonthly' as const, firstPeriodEnd: '2026-01-15', payDateOffset: 0 };
    expect(payPeriods(s, '2026-02-10', 3)).toEqual([
      { start: '2026-02-01', end: '2026-02-15', payDate: '2026-02-13' }, // Sunday -> Friday
      { start: '2026-02-16', end: '2026-02-28', payDate: '2026-02-27' }, // Saturday -> Friday
      { start: '2026-03-01', end: '2026-03-15', payDate: '2026-03-13' },
    ]);
  });

  it('monthly periods keep the anchor day, clamped to short months, or the month end', () => {
    const s = { frequency: 'monthly' as const, firstPeriodEnd: '2026-01-30', payDateOffset: 0 };
    expect(payPeriods(s, '2026-01-31', 2).map((p) => [p.start, p.end])).toEqual([
      ['2026-01-31', '2026-02-28'],
      ['2026-03-01', '2026-03-30'],
    ]);
    const m = { frequency: 'monthly' as const, firstPeriodEnd: '2026-04-30', payDateOffset: 0 };
    expect(payPeriods(m, '2026-02-01', 2).map((p) => [p.start, p.end])).toEqual([
      ['2026-02-01', '2026-02-28'],
      ['2026-03-01', '2026-03-31'],
    ]);
  });

  it('moves weekend pay dates back to Friday', () => {
    expect(payDateFor('2026-10-02', 1)).toBe('2026-10-02'); // Sat -> Fri
    expect(payDateFor('2026-10-02', 2)).toBe('2026-10-02'); // Sun -> Fri
    expect(payDateFor('2026-10-02', 3)).toBe('2026-10-05'); // Mon
  });

  it('semimonthly schedules must be anchored on the 15th or month end', () => {
    const base = { name: 'Twice monthly', frequency: 'semimonthly' };
    expect(
      payScheduleInputSchema.safeParse({ ...base, firstPeriodEnd: '2026-02-28' }).success,
    ).toBe(true);
    expect(
      payScheduleInputSchema.safeParse({ ...base, firstPeriodEnd: '2026-02-20' }).success,
    ).toBe(false);
  });
});

describe('setup inputs', () => {
  it('unemployment rates are percentages up to 25 with 4 decimals', () => {
    expect(unemploymentRateInputSchema.parse({ year: 2026, rate: '2.7%' }).rate).toBe('2.7');
    expect(unemploymentRateInputSchema.safeParse({ year: 2026, rate: '26' }).success).toBe(false);
    expect(unemploymentRateInputSchema.safeParse({ year: 2026, rate: '1.23456' }).success).toBe(
      false,
    );
    expect(unemploymentRateInputSchema.safeParse({ year: 2026, rate: '1e3' }).success).toBe(false);
  });

  it('accruing PTO policies need a rate', () => {
    const p = { name: 'Vacation', kind: 'vacation', accrualMethod: 'per_hour_worked' };
    expect(ptoPolicyInputSchema.safeParse(p).success).toBe(false);
    expect(ptoPolicyInputSchema.safeParse({ ...p, accrualRate: '0.0385' }).success).toBe(true);
    expect(ptoPolicyInputSchema.safeParse({ ...p, accrualMethod: 'none' }).success).toBe(true);
  });

  it('payroll items: multiples only on overtime, garnishment types only on garnishments', () => {
    expect(payrollItemInputSchema.safeParse({ name: 'OT', kind: 'overtime' }).success).toBe(false);
    expect(
      payrollItemInputSchema.safeParse({ name: 'OT', kind: 'overtime', rateMultiplier: '1.5' })
        .success,
    ).toBe(true);
    expect(
      payrollItemInputSchema.safeParse({ name: 'Bonus', kind: 'bonus', rateMultiplier: '2' })
        .success,
    ).toBe(false);
    expect(payrollItemInputSchema.safeParse({ name: 'CS', kind: 'garnishment' }).success).toBe(
      false,
    );
    expect(
      payrollItemInputSchema.safeParse({
        name: 'CS',
        kind: 'garnishment',
        garnishmentType: 'child_support',
      }).success,
    ).toBe(true);
    expect(
      payrollItemInputSchema.safeParse({
        name: '401k',
        kind: 'traditional_401k',
        garnishmentType: 'creditor',
      }).success,
    ).toBe(false);
  });
});

describe('employees', () => {
  const employee = {
    firstName: 'Ana',
    lastName: 'Ruiz',
    workState: 'TX',
    hireDate: '2026-03-02',
    payType: 'hourly',
    payRate: '22.50',
    payScheduleId: SCHEDULE,
  };

  it('accepts a minimal hourly employee', () => {
    const e = employeeInputSchema.parse(employee);
    expect(e).toMatchObject({ payMethod: 'check', overtimeExempt: false, payRate: '22.50' });
  });

  it('only supported work states', () => {
    expect(employeeInputSchema.safeParse({ ...employee, workState: 'WA' }).success).toBe(false);
  });

  it('hourly and salaried employees need a rate; commission-only do not', () => {
    expect(employeeInputSchema.safeParse({ ...employee, payRate: '' }).success).toBe(false);
    expect(
      employeeInputSchema.safeParse({ ...employee, payType: 'commission', payRate: '' }).success,
    ).toBe(true);
  });

  it('the last day cannot be before the hire date', () => {
    const r = employeeInputSchema.safeParse({ ...employee, terminationDate: '2026-03-01' });
    expect(r.success).toBe(false);
    expect(employeeInputSchema.safeParse({ ...employee, terminationReason: 'Quit' }).success).toBe(
      false,
    );
  });
});

describe('Form W-4', () => {
  it('2020+ forms take Steps 2 to 4, pre-2020 forms take allowances', () => {
    const w = w4InputSchema.parse({
      formVersion: '2020',
      effectiveFrom: '2026-01-01',
      filingStatus: 'married_jointly',
      multipleJobs: true,
      dependentsAmount: '$4,000',
    });
    expect(w).toMatchObject({ dependentsAmount: '4000', otherIncome: '0', exempt: false });
    expect(
      w4InputSchema.safeParse({
        formVersion: '2020',
        effectiveFrom: '2026-01-01',
        filingStatus: 'married',
      }).success,
    ).toBe(false);
    expect(
      w4InputSchema.parse({
        formVersion: 'pre2020',
        effectiveFrom: '2019-06-01',
        filingStatus: 'married_single_rate',
        allowances: 3,
      }),
    ).toMatchObject({ allowances: 3, extraWithholding: '0' });
  });
});

describe('state certificates', () => {
  it('validates each state form', () => {
    expect(
      stateCertificateInputSchema.parse({
        state: 'IL',
        effectiveFrom: '2026-01-01',
        fields: { basicAllowances: 1 },
      }).fields,
    ).toEqual({
      basicAllowances: 1,
      additionalAllowances: 0,
      additionalWithholding: '0',
      exempt: false,
    });
    expect(
      stateCertificateInputSchema.safeParse({
        state: 'CA',
        effectiveFrom: '2026-01-01',
        fields: { filingStatus: 'married', regularAllowances: 2 },
      }).success,
    ).toBe(true);
    expect(
      stateCertificateInputSchema.safeParse({
        state: 'TX',
        effectiveFrom: '2026-01-01',
        fields: {},
      }).success,
    ).toBe(false);
  });

  it('a New Yorker lives in New York City or Yonkers, not both', () => {
    const r = stateCertificateInputSchema.safeParse({
      state: 'NY',
      effectiveFrom: '2026-01-01',
      fields: { filingStatus: 'single', nycResident: true, yonkersResident: true },
    });
    expect(r.success).toBe(false);
  });
});

describe('direct deposit accounts', () => {
  const acct = (over: object) => ({
    routingNumber: '021000021',
    accountNumber: '123456789',
    accountType: 'checking',
    amountType: 'remainder',
    ...over,
  });

  it('exactly one account gets the rest, and it comes last', () => {
    expect(bankAccountsInputSchema.safeParse({ accounts: [] }).success).toBe(true);
    expect(bankAccountsInputSchema.safeParse({ accounts: [acct({})] }).success).toBe(true);
    expect(
      bankAccountsInputSchema.safeParse({
        accounts: [acct({ amountType: 'fixed', amount: '100' }), acct({})],
      }).success,
    ).toBe(true);
    expect(
      bankAccountsInputSchema.safeParse({
        accounts: [acct({}), acct({ amountType: 'fixed', amount: '100' })],
      }).success,
    ).toBe(false);
    expect(
      bankAccountsInputSchema.safeParse({ accounts: [acct({ amountType: 'fixed', amount: '5' })] })
        .success,
    ).toBe(false);
  });

  it('percentages cannot exceed 100% and amounts are required', () => {
    expect(
      bankAccountsInputSchema.safeParse({
        accounts: [
          acct({ amountType: 'percent', amount: '60' }),
          acct({ amountType: 'percent', amount: '50' }),
          acct({}),
        ],
      }).success,
    ).toBe(false);
    expect(
      bankAccountsInputSchema.safeParse({
        accounts: [acct({ amountType: 'percent' }), acct({})],
      }).success,
    ).toBe(false);
  });

  it('new accounts need a number; the routing number must be real', () => {
    expect(
      bankAccountsInputSchema.safeParse({ accounts: [acct({ accountNumber: undefined })] }).success,
    ).toBe(false);
    expect(
      bankAccountsInputSchema.safeParse({
        accounts: [acct({ accountNumber: undefined, id: SCHEDULE })],
      }).success,
    ).toBe(true);
    expect(
      bankAccountsInputSchema.safeParse({ accounts: [acct({ routingNumber: '021000022' })] })
        .success,
    ).toBe(false);
  });
});

describe('recurring pay items', () => {
  it('take an amount or a percentage, not both', () => {
    const item = { payrollItemId: SCHEDULE };
    expect(employeePayItemsInputSchema.safeParse({ items: [item] }).success).toBe(false);
    expect(
      employeePayItemsInputSchema.safeParse({ items: [{ ...item, amount: '50', percent: '5' }] })
        .success,
    ).toBe(false);
    expect(
      employeePayItemsInputSchema.safeParse({ items: [{ ...item, percent: '5' }] }).success,
    ).toBe(true);
  });
});
