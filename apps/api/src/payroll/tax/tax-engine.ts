import {
  PAYROLL_ITEM_KINDS,
  ZERO,
  type CaDe4Fields,
  type IlW4Fields,
  type Money,
  type NyIt2104Fields,
  type PayFrequency,
  type PayrollItemKind,
  type PayrollState,
  type W4FilingStatus,
  type W4Version,
  parseMoney,
} from '@acct/shared';
import {
  Q0,
  add,
  cmp,
  dec,
  div,
  fromMoney,
  max,
  min,
  mul,
  pct,
  q,
  roundCents,
  sub,
  toCents,
  type Q,
} from './rational';
import {
  isPending,
  type AnnualBracket,
  type FederalTaxData,
  type IlWithholding,
  type PayrollTaxData,
  type RateRow,
  type StateTaxData,
  type StateWageRule,
} from './tax-data-types';

/**
 * The payroll tax engine (ADR 0016). Pure functions over the year's `tax-data`: no rate, wage
 * base or taxability rule lives here (CLAUDE.md rule 7). Anything the data marks `pending`, or
 * doesn't cover, is refused with a reason rather than guessed.
 */

export class TaxCalculationRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(reasons.join(' '));
  }
}

export const TAX_CODES = [
  'federal_income',
  'social_security_employee',
  'social_security_employer',
  'medicare_employee',
  'medicare_employer',
  'additional_medicare',
  'futa',
  'state_income',
  'nyc_income',
  'yonkers_income',
  'state_unemployment',
  'ny_reemployment_fund',
  'ca_ett',
  'ca_sdi',
] as const;
export type TaxCode = (typeof TAX_CODES)[number];

export interface W4Facts {
  formVersion: W4Version;
  filingStatus: W4FilingStatus;
  multipleJobs: boolean;
  dependentsAmount: Money;
  otherIncome: Money;
  deductions: Money;
  extraWithholding: Money;
  allowances: number;
  exempt: boolean;
  nonresidentAlien: boolean;
}

export type StateCertificateFacts =
  | { state: 'IL'; fields: IlW4Fields }
  | { state: 'CA'; fields: CaDe4Fields }
  | { state: 'NY'; fields: NyIt2104Fields };

/** Taxable wages paid earlier in the calendar year, for wage bases and thresholds. */
export interface YtdWages {
  socialSecurity: Money;
  medicare: Money;
  futa: Money;
  stateUnemployment: Money;
  sdi: Money;
  /** Supplemental wages, for the $1 million mandatory rate. */
  supplemental: Money;
}
export const NO_YTD: YtdWages = {
  socialSecurity: ZERO,
  medicare: ZERO,
  futa: ZERO,
  stateUnemployment: ZERO,
  sdi: ZERO,
  supplemental: ZERO,
};

export interface PaycheckTaxInput {
  frequency: PayFrequency;
  workState: PayrollState;
  /** The Form W-4 in effect on the pay date, or null when none is on file. */
  w4: W4Facts | null;
  /** True when the employee was first paid before 2020 (for the no-W-4 and nonresident rules). */
  firstPaidBefore2020: boolean;
  stateCertificate: StateCertificateFacts | null;
  /** Earnings, deductions and company contributions, all as positive amounts. */
  items: { kind: PayrollItemKind; amount: Money }[];
  /**
   * The paycheck is supplemental wages paid separately (a bonus check): income tax uses the
   * flat supplemental rates.
   */
  supplemental: boolean;
  ytd: YtdWages;
  /** The employer's unemployment rate for the year in the work state (percent), if entered. */
  unemploymentRatePercent: string | null;
}

export interface TaxLine {
  code: TaxCode;
  payer: 'employee' | 'employer';
  /** The work state for state and local taxes; null for federal. */
  state: PayrollState | null;
  taxableWages: Money;
  amount: Money;
}

export interface PaycheckTaxResult {
  lines: TaxLine[];
  wages: {
    federalIncome: Money;
    socialSecurity: Money;
    medicare: Money;
    futa: Money;
    stateIncome: Money;
    stateUnemployment: Money;
    sdi: Money;
  };
  /** Things the payroll admin should know, such as a missing Form W-4. */
  notices: string[];
}

const KIND_LABEL = (k: PayrollItemKind) => PAYROLL_ITEM_KINDS[k].label;
const STATE_NAMES: Record<PayrollState, string> = {
  CA: 'California',
  FL: 'Florida',
  IL: 'Illinois',
  NY: 'New York',
  TX: 'Texas',
};

// ---- Taxable wages ------------------------------------------------------------------------------

type FederalTax = 'fit' | 'fica' | 'futa';

/**
 * Taxable wages for one tax: taxable earnings and company contributions, less exempt pre-tax
 * deductions. After-tax deductions don't change taxable wages unless the data says otherwise.
 */
export function federalWages(
  fed: FederalTaxData,
  items: PaycheckTaxInput['items'],
  tax: FederalTax,
  refuse: string[],
): Q {
  let total = Q0;
  for (const { kind, amount } of items) {
    const effect = federalEffect(fed, kind, tax, refuse);
    if (effect) total = add(total, mul(fromMoney(amount), q(BigInt(effect))));
  }
  return max(total, Q0);
}

/** +1 adds the item to taxable wages, -1 subtracts it, 0 leaves it out. */
function federalEffect(
  fed: FederalTaxData,
  kind: PayrollItemKind,
  tax: FederalTax,
  refuse: string[],
): -1 | 0 | 1 {
  const category = PAYROLL_ITEM_KINDS[kind].category;
  const rules = fed.taxabilityByItemKind;
  let taxability: 'taxable' | 'exempt' | null = null;
  if (rules.regularWageKinds.kinds.includes(kind)) taxability = rules.regularWageKinds[tax];
  else {
    const rule = rules.kinds[kind];
    if (isPending(rule)) {
      pushOnce(refuse, `${KIND_LABEL(kind)}: its federal tax treatment isn't sourced yet.`);
      return 0;
    }
    if (rule) taxability = rule[tax];
  }
  if (taxability === null) {
    if (category === 'post_tax_deduction') return 0;
    pushOnce(refuse, `${KIND_LABEL(kind)}: there is no federal tax treatment for this kind.`);
    return 0;
  }
  switch (category) {
    case 'earning':
    case 'employer_contribution':
      return taxability === 'taxable' ? 1 : 0;
    case 'pre_tax_deduction':
      return taxability === 'exempt' ? -1 : 0;
    case 'post_tax_deduction':
      return 0;
  }
}

export function stateWages(
  fed: FederalTaxData,
  rule: StateWageRule | undefined,
  items: PaycheckTaxInput['items'],
  fitWages: Q,
  what: string,
  refuse: string[],
): Q {
  if (!rule || isPending(rule)) {
    refuse.push(`${what}: which wages are taxable isn't sourced yet.`);
    return Q0;
  }
  if ('basis' in rule) return fitWages;
  let total = Q0;
  for (const { kind, amount } of items) {
    const category = PAYROLL_ITEM_KINDS[kind].category;
    const listed = rule.kinds[kind];
    const taxability = fed.taxabilityByItemKind.regularWageKinds.kinds.includes(kind)
      ? rule.regularWages
      : (listed ?? null);
    if (taxability === null) {
      // After-tax deductions (the federal check refuses the unsourced ones).
      if (category === 'post_tax_deduction') continue;
      refuse.push(`${what}: the treatment of ${KIND_LABEL(kind)} isn't sourced yet.`);
      continue;
    }
    const m = fromMoney(amount);
    if (category === 'earning' || category === 'employer_contribution') {
      if (taxability === 'taxable') total = add(total, m);
    } else if (taxability === 'exempt') total = sub(total, m);
  }
  return max(total, Q0);
}

// ---- Federal income tax (Pub. 15-T Worksheet 1A) ---------------------------------------------

function bracketTax(table: AnnualBracket[], amount: Q): Q {
  const row = table.find(
    (r) =>
      cmp(amount, dec(r.atLeast)) >= 0 && (r.lessThan === null || cmp(amount, dec(r.lessThan)) < 0),
  );
  if (!row) throw new Error('No bracket for amount');
  return add(dec(row.base), mul(sub(amount, dec(row.excessOver)), pct(row.ratePercent)));
}

/** The Pub. 15-T percentage method for one paycheck's federal income tax wages. */
export function federalIncomeTax(
  fed: FederalTaxData,
  w4: W4Facts,
  frequency: PayFrequency,
  fitWages: Q,
  firstPaidBefore2020: boolean,
): Q {
  const itw = fed.incomeTaxWithholding;
  if (w4.exempt) return Q0;
  const periods = q(BigInt(itw.payPeriodsPerYear[frequency]));
  let wages = fitWages;
  if (w4.nonresidentAlien) {
    const table =
      w4.formVersion === '2020' || !firstPaidBefore2020
        ? itw.nonresidentAlienAddition.w4From2020OrFirstPaid2020OrLater
        : itw.nonresidentAlienAddition.firstPaidBefore2020NoNewW4;
    wages = add(wages, dec(table[frequency]));
  }
  const annual = mul(wages, periods); // 1c
  let adjusted: Q;
  let table: AnnualBracket[];
  if (w4.formVersion === '2020') {
    const status = w4.filingStatus as 'single' | 'married_jointly' | 'head_of_household';
    const adjustment = w4.multipleJobs
      ? Q0
      : dec(
          status === 'married_jointly'
            ? itw.step2NotCheckedAdjustment.married_jointly
            : itw.step2NotCheckedAdjustment.other,
        );
    adjusted = max(
      sub(add(annual, fromMoney(w4.otherIncome)), add(fromMoney(w4.deductions), adjustment)),
      Q0,
    );
    table = (w4.multipleJobs ? itw.annualTables.step2Checkbox : itw.annualTables.standard)[status];
  } else {
    adjusted = max(sub(annual, mul(q(BigInt(w4.allowances)), dec(itw.pre2020AllowanceValue))), Q0);
    const married = itw.pre2020.marriedStatuses.includes(w4.filingStatus);
    table = itw.annualTables.standard[married ? 'married_jointly' : 'single'];
  }
  const tentative = div(bracketTax(table, adjusted), periods); // 2h
  const credits = w4.formVersion === '2020' ? div(fromMoney(w4.dependentsAmount), periods) : Q0;
  return add(max(sub(tentative, credits), Q0), fromMoney(w4.extraWithholding));
}

/** Pub. 15-T: without a Form W-4, withhold as single with no adjustments. */
function defaultW4(firstPaidBefore2020: boolean): W4Facts {
  return {
    formVersion: firstPaidBefore2020 ? 'pre2020' : '2020',
    filingStatus: 'single',
    multipleJobs: false,
    dependentsAmount: ZERO,
    otherIncome: ZERO,
    deductions: ZERO,
    extraWithholding: ZERO,
    allowances: 0,
    exempt: false,
    nonresidentAlien: false,
  };
}

/** Flat-rate federal withholding on supplemental wages paid separately. */
function federalSupplemental(fed: FederalTaxData, wages: Q, ytdSupplemental: Money): Q {
  const s = fed.supplementalWages;
  const threshold = dec(s.mandatoryThreshold);
  const before = fromMoney(ytdSupplemental);
  const room = max(sub(threshold, before), Q0);
  const atFlat = min(wages, room);
  const atMandatory = sub(wages, atFlat);
  return add(
    mul(atFlat, pct(s.optionalFlatRatePercent)),
    mul(atMandatory, pct(s.mandatoryRatePercent)),
  );
}

// ---- Illinois (IL-700-T automated payroll method) ----------------------------------------------

const NO_IL_ALLOWANCES: IlW4Fields = {
  basicAllowances: 0,
  additionalAllowances: 0,
  additionalWithholding: '0',
  exempt: false,
};

function illinoisIncomeTax(il: IlWithholding, cert: IlW4Fields, periods: number, wages: Q): Q {
  if (cert.exempt) return Q0;
  const allowance = div(
    add(
      mul(q(BigInt(cert.basicAllowances)), dec(il.line1AllowanceAnnual)),
      mul(q(BigInt(cert.additionalAllowances)), dec(il.line2AllowanceAnnual)),
    ),
    q(BigInt(periods)),
  );
  const tax = mul(max(sub(wages, allowance), Q0), pct(il.ratePercent));
  return add(tax, certMoney(cert.additionalWithholding));
}

// ---- New York (NYS-50-T Method II / III, NYC, Yonkers) -----------------------------------------

/** The booklets also have daily tables, used by their worked examples. */
export type NyFrequency = PayFrequency | 'daily';

type NyTables = {
  tableA_deductionPlusExemptions: {
    values: Record<string, Record<'single' | 'married', string[]>>;
  };
  tableC_exemptionValue: Record<string, string>;
};

/** Table A deduction and exemptions; above 10 exemptions, Table B (0 column) plus Table C each. */
function nyDeduction(
  t: NyTables,
  frequency: NyFrequency,
  status: 'single' | 'married',
  exemptions: number,
): Q {
  const column = t.tableA_deductionPlusExemptions.values[frequency]![status];
  if (exemptions < column.length) return dec(column[exemptions]!);
  return add(dec(column[0]!), mul(q(BigInt(exemptions)), dec(t.tableC_exemptionValue[frequency]!)));
}

function rateTableTax(rows: RateRow[], net: Q): Q | null {
  const row = rows.find(
    (r) => cmp(net, dec(r.atLeast)) >= 0 && (r.lessThan === null || cmp(net, dec(r.lessThan)) < 0),
  );
  if (!row) return null;
  // Each step is rounded to the cent, as in the booklets' worked examples.
  return add(roundCents(mul(sub(net, dec(row.subtract)), pct(row.ratePercent))), dec(row.plus));
}

export function newYorkStateTax(
  ny: StateTaxData,
  frequency: NyFrequency,
  periods: number,
  status: 'single' | 'married',
  exemptions: number,
  wages: Q,
): Q {
  const t = ny.stateIncomeTaxWithholding!;
  const net = max(sub(roundCents(wages), nyDeduction(t, frequency, status, exemptions)), Q0);
  const annualNet = mul(net, q(BigInt(periods)));
  const top = t.method3TopRates[status];
  if (cmp(annualNet, dec(top[0]!.atLeast)) >= 0) {
    const row = top.find(
      (r) =>
        cmp(annualNet, dec(r.atLeast)) >= 0 &&
        (r.lessThan === null || cmp(annualNet, dec(r.lessThan)) < 0),
    )!;
    return roundCents(div(mul(annualNet, pct(row.ratePercent)), q(BigInt(periods))));
  }
  const tax = rateTableTax(t.rateTables[status][frequency], net);
  if (tax === null) throw new Error('No New York rate row for net wages');
  return tax;
}

export function newYorkCityTax(
  ny: StateTaxData,
  frequency: NyFrequency,
  status: 'single' | 'married',
  exemptions: number,
  wages: Q,
): Q {
  const t = ny.nycResidentWithholding!;
  const net = max(sub(roundCents(wages), nyDeduction(t, frequency, status, exemptions)), Q0);
  const tax = rateTableTax(t.rateTables[frequency], net);
  if (tax === null) throw new Error('No New York City rate row for net wages');
  return tax;
}

/** Method VIII: the Yonkers nonresident earnings tax, annualized with exclusions. */
export function yonkersNonresidentTax(ny: StateTaxData, periods: number, wages: Q): Q {
  const nr = ny.yonkersWithholding!.nonresident;
  const annual = mul(roundCents(wages), q(BigInt(periods)));
  const row = nr.annualExclusions.find(
    (r) => cmp(annual, dec(r.over)) > 0 && (r.notOver === null || cmp(annual, dec(r.notOver)) <= 0),
  );
  if (!row || row.exclusion === null) return Q0;
  return roundCents(
    div(mul(sub(annual, dec(row.exclusion)), pct(nr.ratePercent)), q(BigInt(periods))),
  );
}

export function yonkersResidentTax(ny: StateTaxData, stateTax: Q): Q {
  return roundCents(
    mul(roundCents(stateTax), pct(ny.yonkersWithholding!.resident.surchargeRatePercent)),
  );
}

// ---- The paycheck -----------------------------------------------------------------------------

/** Certificate amounts are decimal strings, as the forms are stored. */
function certMoney(s: string): Q {
  return fromMoney(parseMoney(s));
}

function pushOnce(list: string[], reason: string) {
  if (!list.includes(reason)) list.push(reason);
}

/** Taxable wages this paycheck under a wage base, given what was taxed earlier in the year. */
function underBase(wages: Q, base: string | null, ytd: Money): Q {
  if (base === null) return wages;
  return min(wages, max(sub(dec(base), fromMoney(ytd)), Q0));
}

export function calculatePaycheckTaxes(
  data: PayrollTaxData,
  input: PaycheckTaxInput,
): PaycheckTaxResult {
  const fed = data.federal;
  const refuse: string[] = [];
  const notices: string[] = [];
  const lines: TaxLine[] = [];
  const periods = fed.incomeTaxWithholding.payPeriodsPerYear[input.frequency];
  const state = input.workState;
  const stateName = STATE_NAMES[state];
  const line = (
    code: TaxCode,
    payer: TaxLine['payer'],
    taxable: Q,
    amount: Q,
    lineState: PayrollState | null = null,
  ) => {
    const cents = toCents(amount);
    if (cents !== ZERO || code !== 'additional_medicare')
      lines.push({ code, payer, state: lineState, taxableWages: toCents(taxable), amount: cents });
  };

  // Federal wages.
  const fitWages = federalWages(fed, input.items, 'fit', refuse);
  const ficaWages = federalWages(fed, input.items, 'fica', refuse);
  const futaWages = federalWages(fed, input.items, 'futa', refuse);

  // Federal income tax.
  let w4 = input.w4;
  if (!w4) {
    w4 = defaultW4(input.firstPaidBefore2020);
    notices.push(
      'No Form W-4 is on file, so federal tax is withheld as single with no adjustments.',
    );
  }
  if (input.supplemental) {
    line(
      'federal_income',
      'employee',
      fitWages,
      federalSupplemental(fed, fitWages, input.ytd.supplemental),
    );
  } else {
    line(
      'federal_income',
      'employee',
      fitWages,
      federalIncomeTax(fed, w4, input.frequency, fitWages, input.firstPaidBefore2020),
    );
  }

  // Social security, Medicare and Additional Medicare.
  const ss = fed.socialSecurity;
  const ssTaxable = underBase(ficaWages, ss.wageBase, input.ytd.socialSecurity);
  line(
    'social_security_employee',
    'employee',
    ssTaxable,
    mul(ssTaxable, pct(ss.employeeRatePercent)),
  );
  line(
    'social_security_employer',
    'employer',
    ssTaxable,
    mul(ssTaxable, pct(ss.employerRatePercent)),
  );
  const med = fed.medicare;
  line('medicare_employee', 'employee', ficaWages, mul(ficaWages, pct(med.employeeRatePercent)));
  line('medicare_employer', 'employer', ficaWages, mul(ficaWages, pct(med.employerRatePercent)));
  const am = fed.additionalMedicare;
  const before = fromMoney(input.ytd.medicare);
  const amTaxable = max(sub(add(before, ficaWages), max(dec(am.withholdingThreshold), before)), Q0);
  line('additional_medicare', 'employee', amTaxable, mul(amTaxable, pct(am.employeeRatePercent)));

  // FUTA (credit reductions are figured on Form 940 at year end).
  const futaTaxable = underBase(futaWages, fed.futa.wageBase, input.ytd.futa);
  line('futa', 'employer', futaTaxable, mul(futaTaxable, pct(fed.futa.netRatePercent)));

  // State.
  const sd = data.states[state];
  let stateIncomeWages = Q0;
  let suiWages = Q0;
  let sdiWages = Q0;
  if (!sd) {
    refuse.push(`There is no ${data.year} tax data for ${stateName}.`);
  } else {
    // Income tax.
    const itw = sd.incomeTaxWithholding;
    const hasIncomeTax = state === 'NY' || !(itw && 'none' in itw && itw.none);
    if (hasIncomeTax) {
      stateIncomeWages = stateWages(
        fed,
        sd.taxableWages.incomeTax,
        input.items,
        fitWages,
        `${stateName} income tax`,
        refuse,
      );
      stateIncomeTax(sd, input, periods, stateIncomeWages, refuse, line);
    }

    // Unemployment.
    suiWages = stateWages(
      fed,
      sd.taxableWages.unemployment,
      input.items,
      fitWages,
      `${stateName} unemployment tax`,
      refuse,
    );
    const ui = sd.unemployment;
    if (!ui) refuse.push(`${stateName} unemployment tax: the wage base isn't sourced yet.`);
    else if (input.unemploymentRatePercent === null)
      refuse.push(
        `Enter your ${data.year} ${stateName} unemployment rate in Payroll › Setup (it's on your rate notice).`,
      );
    else {
      const taxable = underBase(suiWages, ui.wageBase, input.ytd.stateUnemployment);
      line(
        'state_unemployment',
        'employer',
        taxable,
        mul(taxable, pct(input.unemploymentRatePercent)),
        state,
      );
      if (ui.reemploymentServiceFundRatePercent)
        line(
          'ny_reemployment_fund',
          'employer',
          taxable,
          mul(taxable, pct(ui.reemploymentServiceFundRatePercent)),
          state,
        );
      if (sd.employmentTrainingTax) {
        const ett = sd.employmentTrainingTax;
        const ettTaxable = underBase(suiWages, ett.wageBase, input.ytd.stateUnemployment);
        line('ca_ett', 'employer', ettTaxable, mul(ettTaxable, pct(ett.ratePercent)), state);
      }
    }

    // California SDI.
    if (sd.stateDisabilityInsurance) {
      const sdi = sd.stateDisabilityInsurance;
      sdiWages = stateWages(
        fed,
        sd.taxableWages.sdi,
        input.items,
        fitWages,
        'California SDI',
        refuse,
      );
      const taxable = underBase(sdiWages, sdi.wageBase, input.ytd.sdi);
      line('ca_sdi', 'employee', taxable, mul(taxable, pct(sdi.ratePercent)), state);
    }

    // New York Paid Family Leave is a required employee contribution.
    if (isPending(sd.paidFamilyLeave))
      refuse.push("New York Paid Family Leave: the 2026 rate and cap aren't sourced yet.");
  }

  if (refuse.length) throw new TaxCalculationRefused(refuse);
  return {
    lines,
    wages: {
      federalIncome: toCents(fitWages),
      socialSecurity: toCents(ssTaxable),
      medicare: toCents(ficaWages),
      futa: toCents(futaTaxable),
      stateIncome: toCents(stateIncomeWages),
      stateUnemployment: toCents(suiWages),
      sdi: toCents(sdiWages),
    },
    notices,
  };
}

function stateIncomeTax(
  sd: StateTaxData,
  input: PaycheckTaxInput,
  periods: number,
  wages: Q,
  refuse: string[],
  line: (
    code: TaxCode,
    payer: TaxLine['payer'],
    taxable: Q,
    amount: Q,
    state?: PayrollState | null,
  ) => void,
) {
  const state = input.workState;
  const cert = input.stateCertificate;
  if (state === 'CA') {
    refuse.push(
      "California income tax: the 2026 withholding tables (DE 44) aren't in tax-data yet.",
    );
    return;
  }
  if (state === 'IL') {
    const il = sd.incomeTaxWithholding as IlWithholding;
    if (input.supplemental) {
      refuse.push(
        "Illinois income tax: the rule for supplemental wages paid separately isn't sourced yet.",
      );
      return;
    }
    // Pub. 130: without an IL-W-4, or when it must be disregarded (it claims exemption but the
    // federal Form W-4 doesn't), withhold with no allowances.
    let fields: IlW4Fields | null = cert?.state === 'IL' ? cert.fields : null;
    if (fields?.exempt && !input.w4?.exempt) fields = null;
    if (!fields) {
      if (
        sd.noCertificate &&
        'rule' in sd.noCertificate &&
        sd.noCertificate.rule === 'withhold_with_no_allowances'
      ) {
        fields = NO_IL_ALLOWANCES;
      } else {
        refuse.push("Illinois income tax: what to withhold without an IL-W-4 isn't sourced yet.");
        return;
      }
    }
    line('state_income', 'employee', wages, illinoisIncomeTax(il, fields, periods, wages), state);
    return;
  }
  if (state === 'NY') {
    if (!cert || cert.state !== 'NY') {
      refuse.push("New York income tax: add the employee's Form IT-2104 first.");
      return;
    }
    const f = cert.fields;
    if (f.filingStatus === 'married_single_rate') {
      refuse.push(
        'New York income tax: which table applies to "Married, but withhold at higher single rate" isn\'t confirmed yet.',
      );
      return;
    }
    if (f.exempt) {
      line('state_income', 'employee', wages, Q0, state);
      return;
    }
    const status = f.filingStatus;
    const t = sd.stateIncomeTaxWithholding!;
    const stateTax = input.supplemental
      ? roundCents(mul(wages, pct(t.supplementalRatePercent)))
      : newYorkStateTax(sd, input.frequency, periods, status, f.stateAllowances, wages);
    line('state_income', 'employee', wages, add(stateTax, certMoney(f.additionalState)), state);
    if (f.nycResident) {
      const city = input.supplemental
        ? roundCents(mul(wages, pct(sd.nycResidentWithholding!.supplementalRatePercent)))
        : newYorkCityTax(sd, input.frequency, status, f.cityAllowances, wages);
      line('nyc_income', 'employee', wages, add(city, certMoney(f.additionalCity)), state);
    }
    if (f.yonkersResident) {
      const yonkers = input.supplemental
        ? roundCents(mul(wages, pct(sd.yonkersWithholding!.resident.supplementalRatePercent)))
        : yonkersResidentTax(sd, stateTax);
      line(
        'yonkers_income',
        'employee',
        wages,
        add(yonkers, certMoney(f.additionalYonkers)),
        state,
      );
    }
    return;
  }
  refuse.push(`There is no income tax method for ${state}.`);
}
