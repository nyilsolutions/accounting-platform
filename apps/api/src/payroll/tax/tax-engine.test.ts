import { moneyToString, parseMoney, type Money, type PayrollItemKind } from '@acct/shared';
import { describe, expect, it } from 'vitest';
import { loadTaxData } from '../../common/tax-data';
import { add, dec, div, q, toCents, toDollars } from './rational';
import { loadPayrollTaxData } from './tax-data-types';
import {
  NO_YTD,
  TaxCalculationRefused,
  calculatePaycheckTaxes,
  federalIncomeTax,
  federalWages,
  stateWages,
  newYorkCityTax,
  newYorkStateTax,
  yonkersNonresidentTax,
  yonkersResidentTax,
  type NyFrequency,
  type PaycheckTaxInput,
  type W4Facts,
} from './tax-engine';

const data = loadPayrollTaxData(2026)!;
const fed = data.federal;
const ny = data.states.NY!;
const m = (s: string) => parseMoney(s);
const str = (v: Money) => moneyToString(v);

interface WorkedExample {
  source: string;
  page: number | string;
  what: string;
  inputs?: Record<string, string | number>;
  published: Record<string, string>;
  expectedFromTables?: { withholding: string };
  wageBracketRows?: Record<
    string,
    { page: number; atLeast: string; lessThan: string; published: string }
  >;
}

function w4(partial: Partial<W4Facts>): W4Facts {
  return {
    formVersion: '2020',
    filingStatus: 'single',
    multipleJobs: false,
    dependentsAmount: 0n,
    otherIncome: 0n,
    deductions: 0n,
    extraWithholding: 0n,
    allowances: 0,
    exempt: false,
    nonresidentAlien: false,
    ...partial,
  };
}

describe('federal income tax: golden tests from the Pub. 15 and 15-T worked examples', () => {
  const examples = (fed as unknown as { workedExamples: WorkedExample[] }).workedExamples;
  const withRows = examples.filter((e) => e.wageBracketRows);

  it('covers every worked example that has a wage bracket row', () => {
    expect(withRows).toHaveLength(3);
  });

  // The wage bracket tables are the percentage method at the middle of each row, in dollars.
  for (const ex of withRows) {
    for (const [wages, row] of Object.entries(ex.wageBracketRows!)) {
      it(`${ex.source} p.${ex.page}: ${ex.what}, $${wages}`, () => {
        const i = ex.inputs!;
        expect(Number(wages)).toBeGreaterThanOrEqual(Number(row.atLeast));
        expect(Number(wages)).toBeLessThan(Number(row.lessThan));
        const midpoint = div(add(dec(row.atLeast), dec(row.lessThan)), q(2n));
        const tax = federalIncomeTax(
          fed,
          w4({
            formVersion: i.formVersion as W4Facts['formVersion'],
            filingStatus: i.filingStatus as W4Facts['filingStatus'],
            allowances: Number(i.allowances ?? 0),
          }),
          i.frequency as 'weekly' | 'monthly',
          midpoint,
          true,
        );
        expect(str(toDollars(tax))).toBe(`${row.published}.00`);
        expect(row.published).toBe(ex.published[wages]);
      });
    }
  }

  it('Pub. 15-T p.7: the nonresident alien addition is added to wages for withholding only', () => {
    const tax = federalIncomeTax(
      fed,
      w4({ formVersion: 'pre2020', allowances: 1, nonresidentAlien: true }),
      'weekly',
      dec('300.00'),
      true,
    );
    // ($300 + $226.90) x 52 - $4,300 = $23,098.80; $1,240 + 12% x $3,198.80 = $1,623.856 / 52.
    expect(str(toCents(tax))).toBe('31.23');
    expect(str(toDollars(tax))).toBe('31.00');
  });

  it('Worksheet 1A: Step 2 checkbox, Step 3 credits, Step 4 adjustments and extra withholding', () => {
    // Biweekly $3,000, MFJ, Step 2 checked: annual $78,000 on the checkbox MFJ table.
    const table = fed.incomeTaxWithholding.annualTables.step2Checkbox.married_jointly;
    const row = table.find(
      (r) => Number(r.atLeast) <= 78000 && (r.lessThan === null || 78000 < Number(r.lessThan)),
    )!;
    const expectedAnnual =
      Number(row.base) + ((78000 - Number(row.excessOver)) * Number(row.ratePercent)) / 100;
    const plain = federalIncomeTax(
      fed,
      w4({ filingStatus: 'married_jointly', multipleJobs: true }),
      'biweekly',
      dec('3000'),
      false,
    );
    expect(Number(str(toCents(plain)))).toBeCloseTo(expectedAnnual / 26, 2);
    // $2,600 of dependents credit is $100 a paycheck; $50 extra is added after.
    const withCredits = federalIncomeTax(
      fed,
      w4({
        filingStatus: 'married_jointly',
        multipleJobs: true,
        dependentsAmount: m('2600'),
        extraWithholding: m('50'),
      }),
      'biweekly',
      dec('3000'),
      false,
    );
    expect(toCents(withCredits)).toBe(toCents(plain) - m('100') + m('50'));
    // Step 4(b) deductions equal to a year's wages leave nothing to withhold.
    const none = federalIncomeTax(
      fed,
      w4({ deductions: m('78000') }),
      'biweekly',
      dec('3000'),
      false,
    );
    expect(toCents(none)).toBe(0n);
    // An exempt Form W-4 withholds nothing.
    expect(toCents(federalIncomeTax(fed, w4({ exempt: true }), 'weekly', dec('900'), false))).toBe(
      0n,
    );
  });
});

describe('Illinois: golden test from the IL-700-T automated payroll example', () => {
  const il = loadTaxData<{ workedExamples: WorkedExample[] }>(2026, 'states/il')!;
  const ex = il.workedExamples[0]!;
  it(`${ex.source} p.${ex.page}: ${ex.what}`, () => {
    const result = calculatePaycheckTaxes(data, {
      ...baseInput('IL'),
      frequency: 'weekly',
      items: [{ kind: 'hourly', amount: m(String(ex.inputs!.wages)) }],
      stateCertificate: {
        state: 'IL',
        fields: {
          basicAllowances: Number(ex.inputs!.basicAllowances),
          additionalAllowances: Number(ex.inputs!.additionalAllowances),
          additionalWithholding: '0',
          exempt: false,
        } as never,
      },
    });
    expect(str(line(result, 'state_income').amount)).toBe(ex.published.withholding);
  });
});

describe('New York: golden tests from the NYS-50-T-NYS, -NYC and -Y worked examples', () => {
  const examples = (ny as unknown as { workedExamples: WorkedExample[] }).workedExamples;
  const periods = (f: NyFrequency) =>
    (fed.incomeTaxWithholding.payPeriodsPerYear as Record<string, number>)[f]!;

  it('covers all 27 examples', () => expect(examples).toHaveLength(27));

  for (const ex of examples) {
    const expected = ex.expectedFromTables?.withholding ?? ex.published.withholding!;
    const label = ex.expectedFromTables
      ? `${ex.what} (tables give ${expected}; booklet prints ${ex.published.withholding})`
      : ex.what;
    it(`${ex.source} p.${ex.page}: ${label}`, () => {
      const i = ex.inputs!;
      const frequency = i.period as NyFrequency;
      const status = i.status as 'single' | 'married';
      const exemptions = Number(i.exemptions);
      const wages = dec(String(i.wages));
      let tax;
      if (i.kind === 'yonkersResident') {
        tax = yonkersResidentTax(
          ny,
          newYorkStateTax(ny, frequency, periods(frequency), status, exemptions, wages),
        );
      } else if (i.kind === 'yonkersNonresident') {
        tax = yonkersNonresidentTax(ny, periods(frequency), wages);
      } else if (ex.source === 'nys-50-t-nyc') {
        tax = newYorkCityTax(ny, frequency, status, exemptions, wages);
      } else {
        tax = newYorkStateTax(ny, frequency, periods(frequency), status, exemptions, wages);
      }
      expect(str(toCents(tax))).toBe(expected);
    });
  }

  it('uses Method III when annualized net wages reach the top-rate threshold', () => {
    // Monthly $100,000 single, 0 exemptions: net x 12 is over $1,077,550, so 10.45% of net.
    const net =
      100000 -
      Number(ny.stateIncomeTaxWithholding!.tableA_deductionPlusExemptions.values.monthly.single[0]);
    const tax = newYorkStateTax(ny, 'monthly', 12, 'single', 0, dec('100000'));
    expect(Number(str(toCents(tax)))).toBeCloseTo(net * 0.1045, 2);
  });

  it('above 10 exemptions uses the 0-exemption deduction plus Table C for each', () => {
    const ten = newYorkStateTax(ny, 'weekly', 52, 'single', 10, dec('1500'));
    const twelve = newYorkStateTax(ny, 'weekly', 52, 'single', 12, dec('1500'));
    expect(toCents(twelve)).toBeLessThan(toCents(ten));
  });
});

// ---- The paycheck -------------------------------------------------------------------------------

function baseInput(state: PaycheckTaxInput['workState']): PaycheckTaxInput {
  return {
    payDate: '2026-03-06',
    frequency: 'biweekly',
    workState: state,
    w4: w4({}),
    firstPaidBefore2020: false,
    stateCertificate: null,
    items: [],
    supplemental: false,
    ytd: NO_YTD,
    unemploymentRatePercent: '2.7',
  };
}
function items(...pairs: [PayrollItemKind, string][]) {
  return pairs.map(([kind, amount]) => ({ kind, amount: m(amount) }));
}
function line(result: ReturnType<typeof calculatePaycheckTaxes>, code: string) {
  const found = result.lines.find((l) => l.code === code);
  if (!found) throw new Error(`No ${code} line`);
  return found;
}
function refusal(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof TaxCalculationRefused) return e.reasons;
    throw e;
  }
  throw new Error('Expected the calculation to be refused');
}

describe('a paycheck', () => {
  it('Texas: federal, FICA, FUTA and unemployment, with the rates and bases from tax-data', () => {
    const r = calculatePaycheckTaxes(data, {
      ...baseInput('TX'),
      items: items(['salary', '2000']),
    });
    expect(str(line(r, 'social_security_employee').amount)).toBe('124.00');
    expect(str(line(r, 'social_security_employer').amount)).toBe('124.00');
    expect(str(line(r, 'medicare_employee').amount)).toBe('29.00');
    expect(str(line(r, 'medicare_employer').amount)).toBe('29.00');
    expect(str(line(r, 'futa').amount)).toBe('12.00');
    expect(str(line(r, 'state_unemployment').amount)).toBe('54.00');
    expect(r.lines.find((l) => l.code === 'additional_medicare')).toBeUndefined();
    expect(r.lines.find((l) => l.code === 'state_income')).toBeUndefined();
    // Biweekly $2,000 single: $52,000 - $8,600 = $43,400; $1,240 + 12% x $23,500 = $4,060 / 26.
    expect(str(line(r, 'federal_income').amount)).toBe('156.15');
  });

  it('401(k) is exempt from income tax but not FICA or FUTA; section 125 and HSA from all', () => {
    const pay = items(
      ['salary', '3000'],
      ['traditional_401k', '300'],
      ['section_125', '100'],
      ['hsa', '50'],
      ['garnishment', '75'],
      ['retirement_match', '150'],
      ['reimbursement', '40'],
      ['cash_tips', '60'],
    );
    const refuse: string[] = [];
    expect(str(toCents(federalWages(fed, pay, 'fit', refuse)))).toBe('2610.00');
    expect(str(toCents(federalWages(fed, pay, 'fica', refuse)))).toBe('2910.00');
    expect(str(toCents(federalWages(fed, pay, 'futa', refuse)))).toBe('2910.00');
    expect(refuse).toEqual([]);
  });

  it('Roth deferrals are taxed like pay: income tax, FICA and FUTA (W-2 instructions p.10)', () => {
    const pay = items(['salary', '2000'], ['roth_401k', '100'], ['roth_403b', '50']);
    const refuse: string[] = [];
    for (const tax of ['fit', 'fica', 'futa'] as const)
      expect(str(toCents(federalWages(fed, pay, tax, refuse)))).toBe('2000.00');
    expect(refuse).toEqual([]);
    // After-tax deductions leave every state's wages alone too.
    const r = calculatePaycheckTaxes(data, { ...baseInput('TX'), items: pay });
    expect(str(line(r, 'state_unemployment').taxableWages)).toBe('2000.00');
  });

  it('refuses kinds whose treatment is pending or unknown, and says why', () => {
    const refuse: string[] = [];
    const pendingRoth = {
      ...fed,
      taxabilityByItemKind: {
        ...fed.taxabilityByItemKind,
        kinds: {
          ...fed.taxabilityByItemKind.kinds,
          roth_401k: { status: 'pending' as const, note: 'Not sourced.' },
        },
      },
    };
    federalWages(
      pendingRoth,
      items(['salary', '1000'], ['roth_401k', '100'], ['other_employer_contribution', '10']),
      'fit',
      refuse,
    );
    expect(refuse).toEqual([
      "Roth 401(k): its federal tax treatment isn't sourced yet.",
      'Other company contribution: there is no federal tax treatment for this kind.',
    ]);
  });

  it('refuses state taxes on pay kinds whose state treatment is not sourced', () => {
    const reasons = refusal(() =>
      calculatePaycheckTaxes(data, {
        ...baseInput('FL'),
        items: items(['salary', '2000'], ['traditional_401k', '100']),
      }),
    );
    expect(reasons).toEqual([
      "Florida unemployment tax: the treatment of 401(k) isn't sourced yet.",
    ]);
  });

  it('Texas: salary reductions are unemployment wages whatever they fund; a 401(k) match is not', () => {
    const r = calculatePaycheckTaxes(data, {
      ...baseInput('TX'),
      items: items(
        ['salary', '2000'],
        ['traditional_401k', '100'],
        ['section_125', '50'],
        ['retirement_match', '80'],
      ),
    });
    expect(str(line(r, 'state_unemployment').taxableWages)).toBe('2000.00');
    expect(str(line(r, 'state_unemployment').amount)).toBe('54.00');
    expect(str(line(r, 'federal_income').taxableWages)).toBe('1850.00');
  });

  it('Texas: reported tips and noncash pay are wages; company health plan payments are not (Labor Code 201.081-.082)', () => {
    const r = calculatePaycheckTaxes(data, {
      ...baseInput('TX'),
      items: items(
        ['salary', '2000'],
        ['cash_tips', '120'],
        ['paid_tips', '80'],
        ['fringe_benefit', '50'],
        ['employer_health', '400'],
      ),
    });
    expect(str(line(r, 'state_unemployment').taxableWages)).toBe('2250.00');
    // Reimbursements are still not addressed.
    expect(
      refusal(() =>
        calculatePaycheckTaxes(data, {
          ...baseInput('TX'),
          items: items(['salary', '2000'], ['reimbursement', '40']),
        }),
      ),
    ).toEqual([
      "Texas unemployment tax: the treatment of Expense reimbursement isn't sourced yet.",
    ]);
  });

  it('Florida: cafeteria plan deductions and company health and 401(k) contributions are not wages', () => {
    const r = calculatePaycheckTaxes(data, {
      ...baseInput('FL'),
      items: items(
        ['salary', '2000'],
        ['section_125', '100'],
        ['health_fsa', '50'],
        ['employer_health', '300'],
        ['retirement_match', '80'],
        ['traditional_403b', '60'],
      ),
    });
    // 403(b) salary reductions stay in; cafeteria plan deductions come out.
    expect(str(line(r, 'state_unemployment').taxableWages)).toBe('1850.00');
  });

  it('stops social security at the wage base (Pub. 15 p.30: $2,000 already paid leaves $182,500)', () => {
    const r = calculatePaycheckTaxes(data, {
      ...baseInput('FL'),
      frequency: 'monthly',
      items: items(['salary', '190000']),
      ytd: { ...NO_YTD, socialSecurity: m('2000'), futa: m('2000'), stateUnemployment: m('2000') },
    });
    expect(str(line(r, 'social_security_employee').taxableWages)).toBe('182500.00');
    expect(str(line(r, 'social_security_employee').amount)).toBe('11315.00');
    expect(str(line(r, 'futa').taxableWages)).toBe('5000.00');
    expect(str(line(r, 'state_unemployment').taxableWages)).toBe('5000.00');
    // Nothing is left under the base on the next paycheck.
    const next = calculatePaycheckTaxes(data, {
      ...baseInput('FL'),
      items: items(['salary', '1000']),
      ytd: {
        ...NO_YTD,
        socialSecurity: m('184500'),
        futa: m('7000'),
        stateUnemployment: m('7000'),
      },
    });
    expect(line(next, 'social_security_employee').amount).toBe(0n);
    expect(line(next, 'futa').amount).toBe(0n);
    expect(line(next, 'state_unemployment').amount).toBe(0n);
  });

  it('withholds Additional Medicare only on wages over $200,000 in the year', () => {
    const r = calculatePaycheckTaxes(data, {
      ...baseInput('FL'),
      items: items(['salary', '10000']),
      ytd: { ...NO_YTD, medicare: m('195000') },
    });
    expect(str(line(r, 'additional_medicare').taxableWages)).toBe('5000.00');
    expect(str(line(r, 'additional_medicare').amount)).toBe('45.00');
    expect(r.lines.find((l) => l.code === 'additional_medicare')?.payer).toBe('employee');
  });

  it('supplemental wages paid separately: 22%, and 37% above $1 million in the year', () => {
    const bonus = { ...baseInput('FL'), supplemental: true, items: items(['bonus', '1000']) };
    // Pub. 15 p.24, Example 3: 22% of Sharon's $1,000 bonus.
    expect(str(line(calculatePaycheckTaxes(data, bonus), 'federal_income').amount)).toBe('220.00');
    const big = calculatePaycheckTaxes(data, {
      ...bonus,
      items: items(['bonus', '100000']),
      ytd: { ...NO_YTD, supplemental: m('950000') },
    });
    // $50,000 at 22% and $50,000 at 37%.
    expect(str(line(big, 'federal_income').amount)).toBe('29500.00');
  });

  it('without a Form W-4, withholds as single with no adjustments and says so', () => {
    const r = calculatePaycheckTaxes(data, {
      ...baseInput('TX'),
      w4: null,
      items: items(['salary', '2000']),
    });
    expect(str(line(r, 'federal_income').amount)).toBe('156.15');
    expect(r.notices).toEqual([
      'No Form W-4 is on file, so federal tax is withheld as single with no adjustments.',
    ]);
  });

  it('refuses without an unemployment rate for the year', () => {
    expect(
      refusal(() =>
        calculatePaycheckTaxes(data, {
          ...baseInput('TX'),
          unemploymentRatePercent: null,
          items: items(['salary', '2000']),
        }),
      ),
    ).toEqual([
      "Enter your 2026 Texas unemployment rate in Payroll › Setup (it's on your rate notice).",
    ]);
  });

  it('refuses California until DE 44 is in tax-data', () => {
    const reasons = refusal(() =>
      calculatePaycheckTaxes(data, { ...baseInput('CA'), items: items(['salary', '2000']) }),
    );
    expect(reasons).toContain(
      "California income tax: the 2026 withholding tables (DE 44) aren't in tax-data yet.",
    );
  });

  it('New York Paid Family Leave: 0.432% of wages each paycheck, up to $411.91 a year', () => {
    const r = calculatePaycheckTaxes(data, {
      ...baseInput('NY'),
      stateCertificate: nyCert({}),
      items: items(['salary', '2000']),
    });
    expect(line(r, 'ny_pfl')).toMatchObject({ payer: 'employee', state: 'NY' });
    expect(str(line(r, 'ny_pfl').amount)).toBe('8.64');
    // The PFL example: $1,000 a week is $4.32.
    const weekly = calculatePaycheckTaxes(data, {
      ...baseInput('NY'),
      frequency: 'weekly',
      stateCertificate: nyCert({}),
      items: items(['salary', '1000']),
    });
    expect(str(line(weekly, 'ny_pfl').amount)).toBe('4.32');
    const nearCap = calculatePaycheckTaxes(data, {
      ...baseInput('NY'),
      stateCertificate: nyCert({}),
      items: items(['salary', '2000']),
      ytd: { ...NO_YTD, nyPflContributions: m('405') },
    });
    expect(str(line(nearCap, 'ny_pfl').amount)).toBe('6.91');
  });

  it('New York: more than 14 allowances on an IT-2104 means sending the state a copy (IT-2104-I)', () => {
    const at = (n: number) =>
      calculatePaycheckTaxes(data, {
        ...baseInput('NY'),
        stateCertificate: nyCert({ stateAllowances: n }),
        items: items(['salary', '2000']),
      }).notices;
    expect(at(14)).toEqual([]);
    expect(at(15)).toEqual([
      'The IT-2104 claims more than 14 allowances: send a copy to the New York State Tax Department (box A).',
    ]);
  });

  it('New York unemployment counts noncash pay and certified tips (IA 318.15); PFL waits on them', () => {
    const pay = items(['salary', '2000'], ['fringe_benefit', '75'], ['cash_tips', '40']);
    const refuse: string[] = [];
    const ui = stateWages(
      fed,
      ny.taxableWages.unemployment,
      pay,
      dec('0'),
      'NY',
      refuse,
      '2026-03-06',
    );
    expect(str(toCents(ui))).toBe('2115.00');
    expect(refuse).toEqual([]);
    // Paid Family Leave wages are the "money rate" of the contract of hiring (WCL § 201(12)).
    stateWages(fed, ny.taxableWages.paidFamilyLeave, pay, dec('0'), 'NY PFL', refuse, '2026-03-06');
    expect(refuse).toEqual([
      "NY PFL: the treatment of Taxable fringe benefit isn't sourced yet.",
      "NY PFL: the treatment of Cash tips (reported by the employee) isn't sourced yet.",
    ]);
  });

  it('Illinois without an IL-W-4 withholds with no allowances (Pub. 130); bonuses at the flat rate', () => {
    const r = calculatePaycheckTaxes(data, {
      ...baseInput('IL'),
      items: items(['salary', '2000']),
    });
    // 4.95% of $2,000 with no allowances.
    expect(str(line(r, 'state_income').amount)).toBe('99.00');
    // An IL-W-4 claiming exemption is disregarded unless the federal W-4 is exempt too.
    const exemptIl = {
      state: 'IL' as const,
      fields: {
        basicAllowances: 1,
        additionalAllowances: 0,
        additionalWithholding: '0',
        exempt: true,
      } as never,
    };
    const disregarded = calculatePaycheckTaxes(data, {
      ...baseInput('IL'),
      items: items(['salary', '2000']),
      stateCertificate: exemptIl,
    });
    expect(str(line(disregarded, 'state_income').amount)).toBe('99.00');
    const honored = calculatePaycheckTaxes(data, {
      ...baseInput('IL'),
      w4: w4({ exempt: true }),
      items: items(['salary', '2000']),
      stateCertificate: exemptIl,
    });
    expect(line(honored, 'state_income').amount).toBe(0n);
    // 86 Ill. Adm. Code 100.7050(c): a bonus paid separately at the rate in effect.
    const bonus = calculatePaycheckTaxes(data, {
      ...baseInput('IL'),
      supplemental: true,
      items: items(['bonus', '1000']),
    });
    expect(str(line(bonus, 'state_income').amount)).toBe('49.50');
  });

  it('Illinois: a 401(k) reduces withholding wages but not unemployment wages', () => {
    const r = calculatePaycheckTaxes(data, {
      ...baseInput('IL'),
      items: items(['salary', '2000'], ['traditional_401k', '200']),
    });
    expect(str(line(r, 'state_income').amount)).toBe('89.10');
    expect(str(line(r, 'state_unemployment').taxableWages)).toBe('2000.00');
  });

  it('Illinois: a company 401(k) match is unemployment wages until June 30, 2026, then not', () => {
    const pay = {
      ...baseInput('IL'),
      items: items(['salary', '2000'], ['retirement_match', '100']),
    };
    const june = calculatePaycheckTaxes(data, { ...pay, payDate: '2026-06-30' });
    const july = calculatePaycheckTaxes(data, { ...pay, payDate: '2026-07-01' });
    expect(str(line(june, 'state_unemployment').taxableWages)).toBe('2100.00');
    expect(str(line(july, 'state_unemployment').taxableWages)).toBe('2000.00');
  });

  it('California: pay-type rules from DE 231A and DE 231EB (income tax itself still waits on DE 44)', () => {
    const ca = data.states.CA!;
    const pay = items(
      ['salary', '3000'],
      ['traditional_401k', '300'],
      ['section_125', '100'],
      ['hsa', '50'],
      ['retirement_match', '150'],
      ['employer_hsa', '25'],
      ['reimbursement', '40'],
    );
    const refuse: string[] = [];
    const fit = federalWages(fed, pay, 'fit', refuse);
    // PIT: 401(k) and cafeteria plan excluded; HSA (both sides) included; reimbursement excluded.
    expect(
      str(
        toCents(stateWages(fed, ca.taxableWages.incomeTax, pay, fit, 'CA', refuse, '2026-03-06')),
      ),
    ).toBe('2625.00');
    // UI and SDI: 401(k) included; cafeteria plan excluded; HSA included; match excluded.
    expect(
      str(
        toCents(
          stateWages(fed, ca.taxableWages.unemployment, pay, fit, 'CA', refuse, '2026-03-06'),
        ),
      ),
    ).toBe('2925.00');
    expect(
      str(toCents(stateWages(fed, ca.taxableWages.sdi, pay, fit, 'CA', refuse, '2026-03-06'))),
    ).toBe('2925.00');
    expect(refuse).toEqual([]);
  });

  it('Illinois: 4.95% after allowances, plus the IL-W-4 extra amount, and IL unemployment', () => {
    const r = calculatePaycheckTaxes(data, {
      ...baseInput('IL'),
      frequency: 'weekly',
      unemploymentRatePercent: '3.35',
      items: items(['hourly', '800']),
      stateCertificate: {
        state: 'IL',
        fields: {
          basicAllowances: 2,
          additionalAllowances: 2,
          additionalWithholding: '5',
          exempt: false,
        } as never,
      },
    });
    expect(str(line(r, 'state_income').amount)).toBe('37.13');
    expect(str(line(r, 'state_unemployment').amount)).toBe('26.80');
  });
});

function nyCert(fields: Partial<Record<string, unknown>>): PaycheckTaxInput['stateCertificate'] {
  return {
    state: 'NY',
    fields: {
      filingStatus: 'single',
      nycResident: false,
      yonkersResident: false,
      stateAllowances: 0,
      cityAllowances: 0,
      additionalState: '0',
      additionalCity: '0',
      additionalYonkers: '0',
      exempt: false,
      ...fields,
    } as never,
  };
}
