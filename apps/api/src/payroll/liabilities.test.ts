import { parseMoney, type PayrollTaxCode } from '@acct/shared';
import { describe, expect, it } from 'vitest';
import { loadTaxData } from '../common/tax-data';
import {
  agencyOf,
  payrollLiabilities,
  type LiabilityFacts,
  type LiabilityLine,
} from './liabilities';
import type { FederalTaxData, StateTaxData } from './tax/tax-data-types';

const tax = (
  payDate: string,
  code: PayrollTaxCode,
  amount: string,
  state: string | null = null,
): LiabilityLine => ({
  payDate,
  lineType: 'tax',
  taxCode: code,
  state,
  payrollItemId: null,
  itemName: null,
  amount: parseMoney(amount),
});

function facts(over: Partial<LiabilityFacts>): LiabilityFacts {
  return {
    federal: (y) => loadTaxData<FederalTaxData>(y, 'federal') ?? undefined,
    states: (y, s) => loadTaxData<StateTaxData>(y, `states/${s.toLowerCase()}`) ?? undefined,
    depositSchedule: 'monthly',
    lines: [],
    payments: [],
    today: '2026-01-31',
    ...over,
  };
}
const run = (f: LiabilityFacts) => payrollLiabilities(f, new Map([['k401', '401(k) (Fidelity)']]));

describe('agencies', () => {
  it('groups taxes by who they are paid to', () => {
    const a = (code: PayrollTaxCode, state: string | null = null) =>
      agencyOf({ lineType: 'tax', taxCode: code, state, payrollItemId: null });
    expect(a('federal_income')).toBe('federal_941');
    expect(a('medicare_employer')).toBe('federal_941');
    expect(a('futa')).toBe('federal_940');
    expect(a('nyc_income', 'NY')).toBe('state_withholding:NY');
    expect(a('ca_sdi', 'CA')).toBe('state_withholding:CA');
    expect(a('ca_ett', 'CA')).toBe('state_unemployment:CA');
    expect(a('ny_reemployment_fund', 'NY')).toBe('state_unemployment:NY');
    expect(a('ny_pfl', 'NY')).toBe('ny_pfl');
    expect(a('ny_dbl', 'NY')).toBe('ny_dbl');
    expect(
      agencyOf({ lineType: 'deduction', taxCode: null, state: null, payrollItemId: 'k401' }),
    ).toBe('item:k401');
  });
});

describe('Form 941 deposits (Pub. 15)', () => {
  it('monthly: the month is due on the 15th of the next month, moved off a weekend', () => {
    const { rows } = run(
      facts({
        lines: [
          tax('2026-01-15', 'federal_income', '100'),
          tax('2026-01-29', 'federal_income', '150'),
          tax('2026-01-29', 'social_security_employee', '62'),
          tax('2026-01-29', 'social_security_employer', '62'),
        ],
      }),
    );
    expect(rows).toHaveLength(1);
    // February 15, 2026 is a Sunday.
    expect(rows[0]).toMatchObject({
      agency: 'federal_941',
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      dueDate: '2026-02-16',
      accrued: '374.00',
      balance: '374.00',
      status: 'open',
      nextDay: false,
    });
    expect(rows[0]!.parts).toEqual([
      { label: 'Federal income tax', amount: '250.00' },
      { label: 'Social security', amount: '62.00' },
      { label: 'Social security (company)', amount: '62.00' },
    ]);
  });

  it('semiweekly: Wednesday–Friday pay dates are due the next Wednesday, Saturday–Tuesday the next Friday', () => {
    const { rows } = run(
      facts({
        depositSchedule: 'semiweekly',
        lines: [
          tax('2026-01-30', 'federal_income', '100'), // Friday
          tax('2026-02-03', 'federal_income', '100'), // Tuesday
        ],
      }),
    );
    expect(rows.map((r) => [r.periodStart, r.periodEnd, r.dueDate])).toEqual([
      ['2026-01-28', '2026-01-30', '2026-02-04'],
      ['2026-01-31', '2026-02-03', '2026-02-06'],
    ]);
  });

  it('$100,000 in a deposit period is due the next business day; the depositor becomes semiweekly', () => {
    const { rows, effectiveSchedule } = run(
      facts({
        today: '2026-03-20',
        lines: [
          tax('2026-03-06', 'federal_income', '30000'),
          tax('2026-03-13', 'federal_income', '75000'), // Friday: $105,000 accumulated in March
          tax('2026-03-27', 'federal_income', '10000'), // Friday, now semiweekly
        ],
      }),
    );
    expect(rows.map((r) => [r.periodStart, r.periodEnd, r.dueDate, r.accrued, r.nextDay])).toEqual([
      ['2026-03-13', '2026-03-13', '2026-03-16', '75000.00', true],
      ['2026-03-25', '2026-03-27', '2026-04-01', '10000.00', false],
      ['2026-03-01', '2026-03-31', '2026-04-15', '30000.00', false],
    ]);
    expect(effectiveSchedule).toBe('semiweekly');
  });
});

describe('FUTA deposits', () => {
  it('a quarter under $500 carries forward to the quarter that passes $500; Q4 is due by January 31', () => {
    const { rows } = run(
      facts({
        today: '2026-12-31',
        lines: [
          tax('2026-02-13', 'futa', '300'),
          tax('2026-05-15', 'futa', '300'),
          tax('2026-11-13', 'futa', '40'),
        ],
      }),
    );
    expect(rows.map((r) => [r.periodStart, r.dueDate, r.dueNote !== null])).toEqual([
      ['2026-01-01', '2026-07-31', true],
      ['2026-04-01', '2026-07-31', false],
      // January 31, 2027 is a Sunday.
      ['2026-10-01', '2027-02-01', false],
    ]);
  });

  it('FUTA still at $500 or less is not overdue: it is due by January 31 at the latest', () => {
    const { rows } = run(
      facts({ today: '2026-09-30', lines: [tax('2026-01-15', 'futa', '23.76')] }),
    );
    expect(rows[0]).toMatchObject({ dueDate: '2027-02-01', status: 'open' });
    expect(rows[0]!.dueNote).toMatch(/carried forward/);
  });
});

describe('state and payee liabilities', () => {
  it('state taxes by quarter; due dates only where tax-data has them', () => {
    const { rows } = run(
      facts({
        lines: [
          tax('2026-02-13', 'state_unemployment', '54', 'TX'),
          tax('2026-02-13', 'ca_ett', '2', 'CA'),
          tax('2026-02-13', 'state_income', '99', 'IL'),
        ],
      }),
    );
    const ca = rows.find((r) => r.agency === 'state_unemployment:CA')!;
    expect(ca).toMatchObject({
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
      dueDate: '2026-04-30',
    });
    const tx = rows.find((r) => r.agency === 'state_unemployment:TX')!;
    expect(tx).toMatchObject({ dueDate: null, status: 'no_due_date' });
    expect(tx.dueNote).toMatch(/Texas's quarterly unemployment return/);
    expect(rows.find((r) => r.agency === 'state_withholding:IL')!.agencyLabel).toBe(
      'Illinois: income tax withholding',
    );
  });

  it('Florida unemployment is due with Form RT-6, moved off a weekend (DOR return page)', () => {
    const { rows } = run(
      facts({ lines: [tax('2026-08-14', 'state_unemployment', '54', 'FL')], today: '2026-09-30' }),
    );
    expect(rows.find((r) => r.agency === 'state_unemployment:FL')).toMatchObject({
      periodStart: '2026-07-01',
      periodEnd: '2026-09-30',
      dueDate: '2026-11-02',
      dueNote: expect.stringMatching(/Form RT-6.*5:00 p\.m\. ET the business day before/),
    });
  });

  it('Illinois withholding: new taxpayers are monthly, due the 15th of the next month (Pub. 131)', () => {
    const { rows } = run(facts({ lines: [tax('2026-02-13', 'state_income', '99', 'IL')] }));
    expect(rows.find((r) => r.agency === 'state_withholding:IL')).toMatchObject({
      periodStart: '2026-02-01',
      periodEnd: '2026-02-28',
      // March 15, 2026 is a Sunday.
      dueDate: '2026-03-16',
      dueNote: 'Illinois monthly schedule: due the 15th of the following month.',
    });
  });

  it('Illinois semiweekly: paid separately by quarter even with one due date (Pub. 131 p.4 example)', () => {
    const { rows } = run(
      facts({
        stateDepositSchedules: { IL: 'semiweekly' },
        lines: [
          tax('2026-09-30', 'state_income', '500', 'IL'),
          tax('2026-10-01', 'state_income', '400', 'IL'),
        ],
        today: '2026-09-30',
      }),
    );
    const il = rows.filter((r) => r.agency === 'state_withholding:IL');
    expect(il.map((r) => [r.periodStart, r.periodEnd, r.dueDate, r.accrued])).toEqual([
      ['2026-09-30', '2026-09-30', '2026-10-07', '500.00'],
      ['2026-10-01', '2026-10-02', '2026-10-07', '400.00'],
    ]);
  });

  it('Illinois: more than $12,000 withheld in a quarter makes the next quarter semiweekly', () => {
    const { rows } = run(
      facts({
        lines: [
          tax('2026-01-30', 'state_income', '6000', 'IL'),
          tax('2026-02-27', 'state_income', '6000.01', 'IL'),
          // Friday, April 10: the Wednesday–Friday period is due Wednesday, April 15.
          tax('2026-04-10', 'state_income', '100', 'IL'),
        ],
        today: '2026-04-01',
      }),
    );
    const april = rows.find(
      (r) => r.agency === 'state_withholding:IL' && r.periodStart === '2026-04-08',
    )!;
    expect(april).toMatchObject({ periodEnd: '2026-04-10', dueDate: '2026-04-15' });
    expect(april.dueNote).toMatch(/More than \$12000\.00 was withheld in Q1 2026/);
  });

  it('deductions are owed to the payee on the pay date', () => {
    const { rows } = run(
      facts({
        lines: [
          {
            payDate: '2026-01-29',
            lineType: 'deduction',
            taxCode: null,
            state: null,
            payrollItemId: 'k401',
            itemName: '401(k)',
            amount: parseMoney('100'),
          },
        ],
      }),
    );
    expect(rows[0]).toMatchObject({
      agency: 'item:k401',
      agencyLabel: '401(k) (Fidelity)',
      dueDate: '2026-01-29',
      status: 'overdue',
    });
  });

  it('payments reduce the balance; a paid period is paid', () => {
    const lines = [tax('2026-01-29', 'federal_income', '150')];
    const partly = run(
      facts({
        lines,
        payments: [
          {
            agency: 'federal_941',
            periodStart: '2026-01-01',
            periodEnd: '2026-01-31',
            amount: parseMoney('100'),
          },
        ],
      }),
    ).rows[0]!;
    expect(partly).toMatchObject({ paid: '100.00', balance: '50.00', status: 'open' });
    const paid = run(
      facts({
        lines,
        payments: [
          {
            agency: 'federal_941',
            periodStart: '2026-01-01',
            periodEnd: '2026-01-31',
            amount: parseMoney('150'),
          },
        ],
      }),
    ).rows[0]!;
    expect(paid.status).toBe('paid');
    expect(run(facts({ lines, today: '2026-02-17' })).rows[0]!.status).toBe('overdue');
    expect(run(facts({ lines, today: '2026-02-10' })).rows[0]!.status).toBe('due_soon');
  });
});
