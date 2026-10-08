import { parseMoney, type PayrollItemKind, type PayrollTaxCode } from '@acct/shared';
import { describe, expect, it } from 'vitest';
import { loadTaxData } from '../../common/tax-data';
import { changedFigures } from '../tax-filings';
import type { FederalTaxData, StateTaxData } from '../tax/tax-data-types';
import { buildFederalQuarter, buildFutaAnnual, buildStateQuarter } from './quarterly';
import type { EmployeeFacts, PayRecord, PayRecordLine } from './records';
import { buildW2s, buildW3, qualifiedOvertime } from './w2';

const fed = loadTaxData<FederalTaxData>(2026, 'federal')!;
const m = parseMoney;

const employee = (over: Partial<EmployeeFacts> = {}): EmployeeFacts => ({
  id: 'e1',
  name: 'Alex Rivera',
  ssnMasked: '***-**-6789',
  hasSsn: true,
  address: '1 Main St, Albany, NY 12207',
  overtimeExempt: false,
  tippedOccupationCodes: null,
  ...over,
});
const item = (kind: PayrollItemKind, amount: string, rateMultiplier: string | null = null) =>
  ({
    lineType: 'earning',
    kind,
    rateMultiplier,
    taxCode: null,
    state: null,
    amount: m(amount),
    taxableWages: 0n,
    subjectWages: 0n,
  }) satisfies PayRecordLine;
const tax = (
  code: PayrollTaxCode,
  taxable: string,
  amount: string,
  state: string | null = null,
  subject = taxable,
) =>
  ({
    lineType: 'tax',
    kind: null,
    rateMultiplier: null,
    taxCode: code,
    state,
    amount: m(amount),
    taxableWages: m(taxable),
    subjectWages: m(subject),
  }) satisfies PayRecordLine;
const record = (
  payDate: string,
  lines: PayRecordLine[],
  over: Partial<PayRecord> = {},
): PayRecord => ({
  source: 'paycheck',
  id: payDate,
  employeeId: 'e1',
  payDate,
  lines,
  ...over,
});
const w2 = (records: PayRecord[], e = employee(), stateIds = {}) =>
  buildW2s({ federal: fed, employees: [e], records, stateIds })[0]!;

describe('Form W-2 (2026 General Instructions for Forms W-2 and W-3)', () => {
  it('boxes 3 and 5: $199,750 in wages is $184,500 of social security wages (p.19 example)', () => {
    const w = w2([
      record('2026-12-18', [
        item('salary', '199750'),
        tax('federal_income', '199750', '40000'),
        tax('social_security_employee', '184500', '11439', null, '199750'),
        tax('medicare_employee', '199750', '2896.38'),
      ]),
    ]);
    expect(w).toMatchObject({ box1: '199750.00', box3: '184500.00', box5: '199750.00' });
    expect(w.box4).toBe('11439.00');
    expect(w.problems).toEqual([]);
  });

  it("elective deferrals: Alex's 401(k) and Roth contributions in box 12, not box 1 (p.21 example)", () => {
    // Salary $100,000; $26,500 deferred and $1,000 designated Roth.
    const w = w2([
      record('2026-12-18', [
        item('salary', '100000'),
        { ...item('traditional_401k', '26500'), lineType: 'deduction' },
        { ...item('roth_401k', '1000'), lineType: 'deduction' },
        tax('federal_income', '73500', '9000'),
        tax('social_security_employee', '100000', '6200'),
        tax('medicare_employee', '100000', '1450'),
      ]),
    ]);
    expect(w.box1).toBe('73500.00');
    expect(w.box12).toEqual([
      { code: 'D', amount: '26500.00' },
      { code: 'AA', amount: '1000.00' },
    ]);
    expect(w.retirementPlan).toBe(true);
  });

  it('box 7: reported tips come out of social security wages, and code TP needs box 14b', () => {
    const recs = [
      record('2026-03-06', [
        item('hourly', '800'),
        item('cash_tips', '200'),
        tax('federal_income', '1000', '60'),
        tax('social_security_employee', '1000', '62'),
        tax('medicare_employee', '1000', '14.50'),
      ]),
    ];
    const w = w2(recs);
    expect(w).toMatchObject({ box3: '800.00', box7: '200.00', box5: '1000.00' });
    expect(w.box12).toContainEqual({ code: 'TP', amount: '200.00' });
    expect(w.problems).toContain(
      "Box 14b needs the employee's Treasury tipped occupation code (reported tips, code TP).",
    );
    expect(w2(recs, employee({ tippedOccupationCodes: '101' }))).toMatchObject({
      box14b: '101',
      problems: [],
    });
  });

  it('code TT: only the half above the regular rate of FLSA overtime', () => {
    const recs = [record('2026-03-06', [item('overtime', '300', '1.5')])];
    // $300 at time and a half: $200 regular pay plus a $100 premium.
    expect(qualifiedOvertime(recs, false)).toBe(m('100'));
    expect(qualifiedOvertime(recs, true)).toBe(0n);
    // Double time as an overtime item: only half the regular rate still counts.
    expect(qualifiedOvertime([record('2026-03-06', [item('overtime', '400', '2')])], false)).toBe(
      m('100'),
    );
  });

  it('boxes 10, 12 W, 14a and the state and local boxes', () => {
    const w = w2(
      [
        record('2026-03-06', [
          item('salary', '5000'),
          { ...item('dependent_care_fsa', '200'), lineType: 'deduction' },
          { ...item('hsa', '100'), lineType: 'deduction' },
          { ...item('employer_hsa_cafeteria', '50'), lineType: 'contribution' },
          tax('federal_income', '4700', '400'),
          tax('social_security_employee', '4800', '297.60'),
          tax('medicare_employee', '4800', '69.60'),
          tax('state_income', '4700', '250', 'NY'),
          tax('nyc_income', '4700', '160', 'NY'),
          tax('ny_pfl', '5000', '21.60', 'NY'),
          tax('ny_dbl', '5000', '2.60', 'NY'),
        ]),
      ],
      employee(),
      { NY: 'NY-WT-1001' },
    );
    expect(w.box10).toBe('200.00');
    expect(w.box12).toEqual([{ code: 'W', amount: '150.00' }]);
    expect(w.box14a).toEqual([
      { label: 'NY PFL', amount: '21.60' },
      { label: 'NY DBL', amount: '2.60' },
    ]);
    expect(w.states).toEqual([
      { state: 'NY', employerStateId: 'NY-WT-1001', wages: '4700.00', tax: '250.00' },
    ]);
    expect(w.localities).toEqual([
      { state: 'NY', locality: 'NYC', wages: '4700.00', tax: '160.00' },
    ]);
    expect(w.retirementPlan).toBe(false);
  });

  it('flags what the SSA would reject (reconciliation rules, p.26)', () => {
    const w = w2(
      [
        record('2026-03-06', [
          item('salary', '1000'),
          tax('federal_income', '1000', '0'),
          tax('social_security_employee', '1000', '62'),
          tax('medicare_employee', '900', '13.05'),
          tax('state_income', '1000', '49.50', 'IL'),
        ]),
      ],
      employee({ hasSsn: false, ssnMasked: null, address: null }),
    );
    expect(w.problems).toEqual([
      "The employee's social security number is missing.",
      "The employee's address is missing.",
      'Box 5 is less than boxes 3 and 7.',
      'Box 15 needs your IL withholding account number (Payroll › Setup).',
    ]);
  });

  it('prior payroll with pay needs a federal income tax line for box 1', () => {
    const w = w2([record('2026-02-13', [item('salary', '1000')], { source: 'prior', id: 'p1' })]);
    expect(w.problems).toContain(
      'Prior payroll on 2026-02-13 has pay but no federal income tax line; box 1 needs its wages (enter 0 tax).',
    );
  });

  it('Form W-3 totals the W-2s; box 12a is only deferred compensation', () => {
    const recs = [
      record('2026-03-06', [
        item('salary', '5000'),
        { ...item('traditional_401k', '300'), lineType: 'deduction' },
        { ...item('employer_hsa', '100'), lineType: 'contribution' },
        tax('federal_income', '4800', '400'),
        tax('social_security_employee', '5100', '316.20'),
        tax('medicare_employee', '5100', '73.95'),
        tax('state_income', '4800', '237.60', 'IL'),
      ]),
      record(
        '2026-03-06',
        [
          item('salary', '3000'),
          tax('federal_income', '3000', '200'),
          tax('social_security_employee', '3000', '186'),
          tax('medicare_employee', '3000', '43.50'),
          tax('state_income', '3000', '148.50', 'IL'),
        ],
        { id: 'r2', employeeId: 'e2' },
      ),
    ];
    const w2s = buildW2s({
      federal: fed,
      employees: [employee(), employee({ id: 'e2', name: 'Bea Chen' })],
      records: recs,
      stateIds: { IL: '1234-5678' },
    });
    const w3 = buildW3(w2s, {
      federalForm: '941',
      employerName: 'Prairie Co',
      einLast4: '6789',
      hasAddress: true,
      incomeTaxForm: 'form_1120s',
      stateIds: { IL: '1234-5678' },
    });
    expect(w3).toMatchObject({
      count: 2,
      kindOfPayer: '941',
      kindOfEmployer: 'None apply',
      box1: '7800.00',
      box2: '600.00',
      box3: '8100.00',
      box12a: '300.00',
      state: 'IL',
      employerStateId: '1234-5678',
      box16: '7800.00',
      box17: '386.10',
      problems: [],
    });
  });
});

describe('quarterly and annual summaries', () => {
  const quarterRecords = [
    record('2026-01-16', [
      item('hourly', '1000'),
      item('cash_tips', '100'),
      tax('federal_income', '1100', '90'),
      tax('social_security_employee', '1100', '68.20'),
      tax('social_security_employer', '1100', '68.20'),
      tax('medicare_employee', '1100', '15.95'),
      tax('medicare_employer', '1100', '15.95'),
      tax('futa', '1100', '6.60'),
      tax('state_unemployment', '1100', '29.70', 'TX'),
    ]),
    record('2026-02-13', [
      item('hourly', '1000'),
      tax('federal_income', '1000', '80'),
      tax('social_security_employee', '1000', '62'),
      tax('social_security_employer', '1000', '62'),
      tax('medicare_employee', '1000', '14.50'),
      tax('medicare_employer', '1000', '14.50'),
      tax('futa', '1000', '6.00'),
      tax('state_unemployment', '1000', '27.00', 'TX'),
    ]),
    record('2026-04-10', [item('hourly', '500'), tax('federal_income', '500', '40')]),
  ];

  it('the federal quarter: wages, taxes, liability by month and by day, deposits', () => {
    const q = buildFederalQuarter({
      federal: fed,
      taxYear: 2026,
      quarter: 1,
      depositSchedule: 'semiweekly',
      records: quarterRecords,
      deposits: m('300'),
      priorDeposits: 0n,
      hasPriorPayroll: false,
    });
    expect(q).toMatchObject({
      employeesPaid: 1,
      wages: '2100.00',
      federalIncomeTax: '170.00',
      socialSecurityWages: '2000.00',
      socialSecurityTips: '100.00',
      medicareWagesAndTips: '2100.00',
      socialSecurityTax: '260.40',
      medicareTax: '60.90',
      totalTaxes: '491.30',
      // 12.4% of $2,100 and 2.9% of $2,100.
      taxAtRates: '321.30',
      roundingDifference: '0.00',
      monthlyLiability: ['258.30', '233.00', '0.00'],
      dailyLiability: [
        { date: '2026-01-16', amount: '258.30' },
        { date: '2026-02-13', amount: '233.00' },
      ],
      deposits: '300.00',
      balanceDue: '191.30',
    });
  });

  it('the FUTA year: wages before and after the $7,000 base, by quarter and state', () => {
    const recs = [
      ...quarterRecords.slice(0, 2),
      record('2026-07-10', [tax('futa', '4900', '29.40', null, '9000')], { id: 'q3' }),
    ];
    const f = buildFutaAnnual({
      taxYear: 2026,
      netRatePercent: fed.futa.netRatePercent,
      records: recs,
      workStates: new Map([['e1', 'TX']]),
      deposits: ZERO_DEPOSITS,
      priorDeposits: m('12.60'),
    });
    expect(f).toMatchObject({
      subjectWages: '11100.00',
      taxableWages: '7000.00',
      wagesOverBase: '4100.00',
      tax: '42.00',
      byState: [{ state: 'TX', taxableWages: '7000.00' }],
      quarterlyLiability: ['12.60', '0.00', '29.40', '0.00'],
      // $12.60 deposited through the old payroll service.
      deposits: '12.60',
      priorDeposits: '12.60',
      balanceDue: '29.40',
    });
  });

  it('a state quarter: withholding, and each employee’s total, excess and taxable wages', () => {
    const recs = [
      record('2026-02-13', [
        tax('state_income', '3000', '148.50', 'IL'),
        tax('state_unemployment', '1500', '47.25', 'IL', '3000'),
      ]),
    ];
    const s = buildStateQuarter({
      taxYear: 2026,
      quarter: 1,
      state: 'IL',
      stateName: 'Illinois',
      stateData: loadTaxData<StateTaxData>(2026, 'states/il') ?? undefined,
      records: recs,
      employees: [employee()],
    });
    expect(s.withholding).toEqual([
      { code: 'state_income', label: 'IL income tax', wages: '3000.00', tax: '148.50' },
    ]);
    expect(s.unemployment).toMatchObject({
      subjectWages: '3000.00',
      excessWages: '1500.00',
      taxableWages: '1500.00',
      tax: '47.25',
    });
    // Florida's RT-6 due date comes from tax-data.
    const fl = buildStateQuarter({
      taxYear: 2026,
      quarter: 3,
      state: 'FL',
      stateName: 'Florida',
      stateData: loadTaxData<StateTaxData>(2026, 'states/fl') ?? undefined,
      records: [],
      employees: [],
    });
    expect(fl).toMatchObject({ form: 'RT-6', dueDate: '2026-11-02' });
  });
});

describe('filed forms', () => {
  it('lists every figure that changed since filing', () => {
    const filed = { w2s: [{ employeeName: 'Ana Ruiz', box1: '100.00', box2: '10.00' }] };
    const now = { w2s: [{ employeeName: 'Ana Ruiz', box1: '100.00', box2: '12.50' }] };
    expect(changedFigures(filed, now)).toEqual(['w2s › Ana Ruiz › box2: filed 10.00, now 12.50']);
    expect(changedFigures(filed, filed)).toEqual([]);
  });
});

const ZERO_DEPOSITS = 0n;

describe("a licensed engine's taxes on the forms (ADR 0026)", () => {
  // Fixture figures, not Pennsylvania's.
  const engineTax = (
    code: PayrollTaxCode,
    payer: 'employee' | 'employer',
    taxable: string,
    amount: string,
    jurisdiction: [string, string] | null = null,
  ): PayRecordLine => ({
    ...tax(code, taxable, amount, 'PA'),
    payer,
    jurisdictionCode: jurisdiction?.[0] ?? null,
    jurisdictionName: jurisdiction?.[1] ?? null,
  });
  const recs = ['2026-02-13', '2026-02-27'].map((d) =>
    record(d, [
      item('salary', '2000'),
      tax('federal_income', '2000', '150'),
      tax('social_security_employee', '2000', '124'),
      tax('medicare_employee', '2000', '29'),
      engineTax('state_income', 'employee', '2000', '61.40'),
      engineTax('local_income', 'employee', '2000', '75.00', ['510101', 'Philadelphia']),
      engineTax('local_other', 'employee', '2000', '2.00', ['LST', 'Local services tax']),
      engineTax('state_unemployment', 'employee', '2000', '1.40'),
      engineTax('state_unemployment', 'employer', '2000', '62.00'),
      engineTax('local_other', 'employer', '2000', '5.00', ['BPT', 'Business payroll tax']),
    ]),
  );

  it('W-2: state income tax in boxes 15–17, local income tax in 18–20, the rest in box 14', () => {
    const w = w2(recs, employee(), { PA: '12345678' });
    expect(w.states).toEqual([
      { state: 'PA', employerStateId: '12345678', wages: '4000.00', tax: '122.80' },
    ]);
    expect(w.localities).toEqual([
      { state: 'PA', locality: 'Philadelphia', wages: '4000.00', tax: '150.00' },
    ]);
    expect(w.box14a).toEqual([
      { label: 'Local services tax', amount: '4.00' },
      { label: 'PA UI', amount: '2.80' },
    ]);
  });

  it("state quarterly: employer unemployment only in the wage detail; the engine's taxes by jurisdiction", () => {
    const s = buildStateQuarter({
      taxYear: 2026,
      quarter: 1,
      state: 'PA',
      stateName: 'Pennsylvania',
      stateData: undefined,
      records: recs,
      employees: [employee()],
    });
    expect(s.withholding).toEqual([
      { code: 'state_income', label: 'PA income tax', wages: '4000.00', tax: '122.80' },
      { code: 'local_other', label: 'Local services tax', wages: '4000.00', tax: '4.00' },
      {
        code: 'state_unemployment',
        label: 'PA unemployment tax (employee)',
        wages: '4000.00',
        tax: '2.80',
      },
      { code: 'local_income', label: 'Philadelphia', wages: '4000.00', tax: '150.00' },
    ]);
    expect(s.unemployment).toMatchObject({ taxableWages: '4000.00', tax: '124.00' });
    expect(s.otherEmployerTaxes).toEqual([
      {
        code: 'local_other',
        label: 'Business payroll tax',
        taxableWages: '4000.00',
        amount: '10.00',
      },
    ]);
    expect(s.form).toBeNull();
    expect(s.notes).toEqual([
      "Pennsylvania's quarterly return form and due date aren't in tax-data yet; this report has the figures it needs.",
      "Local taxes are usually filed with each locality, not on the state's return; they're listed here for reference.",
    ]);
  });
});
