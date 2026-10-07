import {
  PAYROLL_TAX_LABELS,
  ZERO,
  moneyToString,
  parseMoney,
  payrollTaxLabel,
  type FederalQuarterDto,
  type FutaAnnualDto,
  type Money,
  type WorkState,
  type PayrollTaxCode,
  type StateQuarterDto,
} from '@acct/shared';
import type { FederalTaxData, StateTaxData } from '../tax/tax-data-types';
import {
  engineTaxGroups,
  payerOf,
  quarterOf,
  sumKinds,
  sumTax,
  type EmployeeFacts,
  type PayRecord,
} from './records';

/**
 * The figures behind the quarterly and annual payroll returns (ADR 0017), from pay records.
 * Pure. Line-by-line Forms 941 and 940 wait on their 2026 instructions; these summaries hold
 * everything those forms are built from.
 */

const m = (v: Money) => moneyToString(v);
const FORM_941_TAXES: PayrollTaxCode[] = [
  'federal_income',
  'social_security_employee',
  'social_security_employer',
  'medicare_employee',
  'medicare_employer',
  'additional_medicare',
];

/** amount × percent% (percent in money units, e.g. parseMoney('12.4')), rounded to the cent. */
function atRate(amount: Money, p: Money): Money {
  const denom = parseMoney('100') * 100n;
  return ((amount * p * 2n + denom) / (denom * 2n)) * 100n;
}

export interface FederalQuarterFacts {
  federal: FederalTaxData;
  taxYear: number;
  quarter: number;
  depositSchedule: 'monthly' | 'semiweekly';
  /** The year's pay records (filtered to the quarter here). */
  records: PayRecord[];
  /** Form 941 deposits recorded for periods in the quarter. */
  deposits: Money;
  /** Form 941 deposits for the quarter made before payroll started here. */
  priorDeposits: Money;
  hasPriorPayroll: boolean;
}

export function buildFederalQuarter(
  f: FederalQuarterFacts,
): Omit<FederalQuarterDto, 'filing' | 'changedSinceFiled'> {
  const recs = f.records.filter(
    (r) => Number(r.payDate.slice(0, 4)) === f.taxYear && quarterOf(r.payDate) === f.quarter,
  );
  let ssWages = ZERO;
  let ssTips = ZERO;
  for (const r of recs) {
    const taxable = sumTax([r], ['social_security_employee'], 'taxableWages');
    const tips = sumKinds([r], ['cash_tips', 'paid_tips']);
    const t = tips < taxable ? tips : taxable;
    ssTips += t;
    ssWages += taxable - t;
  }
  const medicareWages = sumTax(recs, ['medicare_employee'], 'taxableWages');
  const amWages = sumTax(recs, ['additional_medicare'], 'taxableWages');
  const fit = sumTax(recs, ['federal_income'], 'amount');
  const ssTax = sumTax(recs, ['social_security_employee', 'social_security_employer'], 'amount');
  const medTax = sumTax(recs, ['medicare_employee', 'medicare_employer'], 'amount');
  const amTax = sumTax(recs, ['additional_medicare'], 'amount');
  const fed = f.federal;
  const ssRate =
    parseMoney(fed.socialSecurity.employeeRatePercent) +
    parseMoney(fed.socialSecurity.employerRatePercent);
  const medRate =
    parseMoney(fed.medicare.employeeRatePercent) + parseMoney(fed.medicare.employerRatePercent);
  const taxAtRates =
    atRate(ssWages + ssTips, ssRate) +
    atRate(medicareWages, medRate) +
    atRate(amWages, parseMoney(fed.additionalMedicare.employeeRatePercent));
  const total = fit + ssTax + medTax + amTax;

  // Tax liability by month of the quarter and by pay date (Schedule B for semiweekly depositors).
  const monthly = [ZERO, ZERO, ZERO];
  const daily = new Map<string, Money>();
  for (const r of recs) {
    const amount = sumTax([r], FORM_941_TAXES, 'amount');
    monthly[(Number(r.payDate.slice(5, 7)) - 1) % 3]! += amount;
    daily.set(r.payDate, (daily.get(r.payDate) ?? ZERO) + amount);
  }
  const notes: string[] = [];
  if (f.hasPriorPayroll)
    notes.push(
      f.priorDeposits > ZERO
        ? 'Prior payroll is included, and the deposits entered under Prior payroll.'
        : 'Prior payroll is included. Enter the deposits your old payroll service made for this quarter under Prior payroll.',
    );
  const deposits = f.deposits + f.priorDeposits;
  return {
    taxYear: f.taxYear,
    quarter: f.quarter,
    depositSchedule: f.depositSchedule,
    employeesPaid: new Set(recs.map((r) => r.employeeId)).size,
    wages: m(sumTax(recs, ['federal_income'], 'taxableWages')),
    federalIncomeTax: m(fit),
    socialSecurityWages: m(ssWages),
    socialSecurityTips: m(ssTips),
    medicareWagesAndTips: m(medicareWages),
    additionalMedicareWages: m(amWages),
    socialSecurityTax: m(ssTax),
    medicareTax: m(medTax),
    additionalMedicareTax: m(amTax),
    totalTaxes: m(total),
    taxAtRates: m(taxAtRates),
    roundingDifference: m(ssTax + medTax + amTax - taxAtRates),
    monthlyLiability: monthly.map(m),
    dailyLiability: [...daily.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, amount]) => ({ date, amount: m(amount) })),
    deposits: m(deposits),
    priorDeposits: m(f.priorDeposits),
    balanceDue: m(total - deposits),
    notes,
  };
}

export interface FutaAnnualFacts {
  taxYear: number;
  /** The net FUTA rate paychecks use (federal.json futa.netRatePercent). */
  netRatePercent: string;
  records: PayRecord[];
  /** Each employee's work state, for FUTA wages by state. */
  workStates: Map<string, string>;
  deposits: Money;
  priorDeposits: Money;
}

export function buildFutaAnnual(
  f: FutaAnnualFacts,
): Omit<FutaAnnualDto, 'filing' | 'changedSinceFiled'> {
  const recs = f.records.filter((r) => Number(r.payDate.slice(0, 4)) === f.taxYear);
  const subject = sumTax(recs, ['futa'], 'subjectWages');
  const taxable = sumTax(recs, ['futa'], 'taxableWages');
  const tax = sumTax(recs, ['futa'], 'amount');
  const quarterly = [ZERO, ZERO, ZERO, ZERO];
  const byState = new Map<string, Money>();
  for (const r of recs) {
    quarterly[quarterOf(r.payDate) - 1]! += sumTax([r], ['futa'], 'amount');
    // The state whose unemployment tax the paycheck paid, else the employee's work state.
    const state =
      r.lines.find((l) => l.taxCode === 'state_unemployment')?.state ??
      f.workStates.get(r.employeeId) ??
      '';
    byState.set(state, (byState.get(state) ?? ZERO) + sumTax([r], ['futa'], 'taxableWages'));
  }
  return {
    taxYear: f.taxYear,
    subjectWages: m(subject),
    wagesOverBase: m(subject - taxable),
    taxableWages: m(taxable),
    tax: m(tax),
    byState: [...byState.entries()]
      .filter(([, v]) => v > ZERO)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([state, wages]) => ({ state, taxableWages: m(wages) })),
    quarterlyLiability: quarterly.map(m),
    deposits: m(f.deposits + f.priorDeposits),
    priorDeposits: m(f.priorDeposits),
    balanceDue: m(tax - f.deposits - f.priorDeposits),
    notes: [
      `FUTA is figured at the ${f.netRatePercent}% net rate. Credit reduction states for ${f.taxYear} are published by the Department of Labor in November and added on Form 940 (Schedule A).`,
    ],
  };
}

const WITHHOLDING_CODES: PayrollTaxCode[] = [
  'state_income',
  'nyc_income',
  'yonkers_income',
  'ca_sdi',
  'ny_pfl',
  'ny_dbl',
];
const OTHER_EMPLOYER_CODES: PayrollTaxCode[] = ['ny_reemployment_fund', 'ca_ett'];

export interface StateQuarterFacts {
  taxYear: number;
  quarter: number;
  state: WorkState;
  stateName: string;
  stateData: StateTaxData | undefined;
  records: PayRecord[];
  employees: EmployeeFacts[];
}

export function buildStateQuarter(
  f: StateQuarterFacts,
): Omit<StateQuarterDto, 'filing' | 'changedSinceFiled'> {
  const recs = f.records.filter(
    (r) => Number(r.payDate.slice(0, 4)) === f.taxYear && quarterOf(r.payDate) === f.quarter,
  );
  const withholding: StateQuarterDto['withholding'] = [];
  for (const code of WITHHOLDING_CODES) {
    const lines = recs.flatMap((r) =>
      r.lines.filter((l) => l.taxCode === code && l.state === f.state),
    );
    if (lines.length === 0) continue;
    withholding.push({
      code,
      label: payrollTaxLabel(code, f.state),
      wages: m(sumTax(recs, [code], 'taxableWages', f.state)),
      tax: m(sumTax(recs, [code], 'amount', f.state)),
    });
  }
  const employees: StateQuarterDto['unemployment']['employees'] = [];
  for (const e of f.employees) {
    const mine = recs.filter((r) => r.employeeId === e.id);
    const lines = mine.flatMap((r) =>
      r.lines.filter(
        (l) =>
          l.taxCode === 'state_unemployment' && l.state === f.state && payerOf(l) === 'employer',
      ),
    );
    if (lines.length === 0) continue;
    const subject = sumTax(mine, ['state_unemployment'], 'subjectWages', f.state, 'employer');
    const taxable = sumTax(mine, ['state_unemployment'], 'taxableWages', f.state, 'employer');
    employees.push({
      employeeId: e.id,
      name: e.name,
      ssnMasked: e.ssnMasked,
      subjectWages: m(subject),
      excessWages: m(subject - taxable),
      taxableWages: m(taxable),
      tax: m(sumTax(mine, ['state_unemployment'], 'amount', f.state, 'employer')),
    });
  }
  const total = (k: 'subjectWages' | 'excessWages' | 'taxableWages' | 'tax') =>
    m(employees.reduce((a, e) => a + parseMoney(e[k]), ZERO));
  const otherEmployerTaxes: StateQuarterDto['otherEmployerTaxes'] = [];
  for (const code of OTHER_EMPLOYER_CODES) {
    const amount = sumTax(recs, [code], 'amount', f.state);
    if (amount === ZERO) continue;
    otherEmployerTaxes.push({
      code,
      label: PAYROLL_TAX_LABELS[code],
      taxableWages: m(sumTax(recs, [code], 'taxableWages', f.state)),
      amount: m(amount),
    });
  }
  // A licensed engine's other state and local taxes (ADR 0026), by jurisdiction.
  const engine = engineTaxGroups(
    recs,
    (l) =>
      l.jurisdictionName ??
      (l.taxCode === 'state_unemployment'
        ? `${f.state} unemployment tax (employee)`
        : payrollTaxLabel(l.taxCode!, l.state)),
    f.state,
  );
  for (const g of engine) {
    if (g.payer === 'employee')
      withholding.push({
        code: g.code,
        label: g.label,
        wages: m(g.taxableWages),
        tax: m(g.amount),
      });
    else if (g.amount !== ZERO)
      otherEmployerTaxes.push({
        code: g.code,
        label: g.label,
        taxableWages: m(g.taxableWages),
        amount: m(g.amount),
      });
  }
  const returns = f.stateData?.quarterlyReturns;
  const due = returns?.dueDates ?? returns?.delinquentDates;
  const notes: string[] = [];
  if (!returns)
    notes.push(
      `${f.stateName}'s quarterly return form and due date aren't in tax-data yet; this report has the figures it needs.`,
    );
  if (engine.some((g) => g.code === 'local_income' || g.code === 'local_other'))
    notes.push(
      "Local taxes are usually filed with each locality, not on the state's return; they're listed here for reference.",
    );
  if (employees.some((e) => !e.ssnMasked))
    notes.push('Some employees have no social security number; the state needs one for each.');
  return {
    taxYear: f.taxYear,
    quarter: f.quarter,
    state: f.state,
    stateName: f.stateName,
    form: returns?.form ?? null,
    dueDate: due?.[`Q${f.quarter}`] ?? null,
    withholding,
    unemployment: {
      employees,
      subjectWages: total('subjectWages'),
      excessWages: total('excessWages'),
      taxableWages: total('taxableWages'),
      tax: total('tax'),
    },
    otherEmployerTaxes,
    notes,
  };
}
