import type { PayFrequency, PayrollState } from '@acct/shared';
import { loadTaxData } from '../../common/tax-data';

/**
 * The shapes of `tax-data/<year>/federal.json` and `states/<state>.json` that the tax engine
 * reads. Amounts and percentages are decimal strings, exactly as published. Parts that were not
 * sourced carry `status: 'pending'`, and the engine refuses to calculate them.
 */
export interface Pending {
  status: 'pending';
  note?: string;
}
export function isPending(v: unknown): v is Pending {
  return typeof v === 'object' && v !== null && (v as { status?: unknown }).status === 'pending';
}

export interface AnnualBracket {
  atLeast: string;
  lessThan: string | null;
  base: string;
  ratePercent: string;
  excessOver: string;
}
type FitStatus2020 = 'married_jointly' | 'single' | 'head_of_household';

export type Taxability = 'taxable' | 'exempt';
export interface KindTaxability {
  fit: Taxability;
  fica: Taxability;
  futa: Taxability;
}

export interface FederalTaxData {
  year: number;
  socialSecurity: { employeeRatePercent: string; employerRatePercent: string; wageBase: string };
  medicare: { employeeRatePercent: string; employerRatePercent: string };
  additionalMedicare: { employeeRatePercent: string; withholdingThreshold: string };
  futa: { netRatePercent: string; wageBase: string };
  supplementalWages: {
    optionalFlatRatePercent: string;
    mandatoryRatePercent: string;
    mandatoryThreshold: string;
  };
  incomeTaxWithholding: {
    payPeriodsPerYear: Record<PayFrequency, number>;
    step2NotCheckedAdjustment: { married_jointly: string; other: string };
    pre2020AllowanceValue: string;
    pre2020: { marriedStatuses: string[]; singleStatuses: string[] };
    annualTables: {
      standard: Record<FitStatus2020, AnnualBracket[]>;
      step2Checkbox: Record<FitStatus2020, AnnualBracket[]>;
    };
    nonresidentAlienAddition: {
      firstPaidBefore2020NoNewW4: Record<PayFrequency, string>;
      w4From2020OrFirstPaid2020OrLater: Record<PayFrequency, string>;
    };
  };
  taxabilityByItemKind: {
    regularWageKinds: { kinds: string[] } & KindTaxability;
    kinds: Record<string, KindTaxability | Pending>;
  };
}

/** How a state tax finds its taxable wages. */
/** A treatment that changes on a date (by pay date): `before` is exclusive, `from` inclusive. */
export interface DatedTaxability {
  from?: string;
  before?: string;
  taxability: Taxability;
}

export type StateWageRule =
  | { basis: 'federal_fit' }
  | {
      regularWages: Taxability;
      kinds: Record<string, Taxability | DatedTaxability[]>;
      otherKinds: 'pending';
    }
  | Pending;

export interface RateRow {
  atLeast: string;
  lessThan: string | null;
  subtract: string;
  ratePercent: string;
  plus: string;
}
export interface TopRateRow {
  atLeast: string;
  lessThan: string | null;
  ratePercent: string;
}
type NyPeriod = PayFrequency | 'daily' | 'annual';
type NyStatus = 'single' | 'married';

export interface StateTaxData {
  year: number;
  state: PayrollState;
  incomeTaxWithholding?: { none?: true } | Pending | IlWithholding;
  unemployment?: { wageBase: string; reemploymentServiceFundRatePercent?: string };
  employmentTrainingTax?: { ratePercent: string; wageBase: string };
  stateDisabilityInsurance?: { ratePercent: string; wageBase: string | null };
  noCertificate?: Pending | { rule: string };
  paidFamilyLeave?: Pending | { employeeRatePercent: string; annualMaxContribution: string };
  stateIncomeTaxWithholding?: {
    tableA_deductionPlusExemptions: { values: Record<NyPeriod, Record<NyStatus, string[]>> };
    tableC_exemptionValue: Record<NyPeriod, string>;
    rateTables: Record<NyStatus, Record<NyPeriod, RateRow[]>>;
    method3TopRates: Record<NyStatus, TopRateRow[]>;
    supplementalRatePercent: string;
  };
  nycResidentWithholding?: {
    tableA_deductionPlusExemptions: { values: Record<NyPeriod, Record<NyStatus, string[]>> };
    tableC_exemptionValue: Record<NyPeriod, string>;
    rateTables: Record<NyPeriod, RateRow[]>;
    supplementalRatePercent: string;
  };
  yonkersWithholding?: {
    resident: { surchargeRatePercent: string; supplementalRatePercent: string };
    nonresident: {
      ratePercent: string;
      annualExclusions: { over: string; notOver: string | null; exclusion: string | null }[];
    };
  };
  taxableWages: {
    incomeTax?: StateWageRule;
    unemployment: StateWageRule;
    sdi?: StateWageRule;
    paidFamilyLeave?: StateWageRule;
  };
}

export interface IlWithholding {
  ratePercent: string;
  /** Supplemental wages paid separately: the elected flat rate (the rate in effect). */
  supplementalWages?: { method: 'flat_rate' };
  line1AllowanceAnnual: string;
  line2AllowanceAnnual: string;
}

export interface PayrollTaxData {
  year: number;
  federal: FederalTaxData;
  states: Partial<Record<PayrollState, StateTaxData>>;
}

/** The year's payroll tax data, or null when there is no federal file for that year. */
export function loadPayrollTaxData(year: number): PayrollTaxData | null {
  const federal = loadTaxData<FederalTaxData>(year, 'federal');
  if (!federal) return null;
  const states: PayrollTaxData['states'] = {};
  for (const s of ['CA', 'FL', 'IL', 'NY', 'TX'] as const) {
    const data = loadTaxData<StateTaxData>(year, `states/${s.toLowerCase()}`);
    if (data) states[s] = data;
  }
  return { year, federal, states };
}
