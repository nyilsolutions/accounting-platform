import {
  ZERO,
  moneyToString,
  parseMoney,
  type Money,
  type PayrollItemKind,
  type PayrollTaxCode,
  type W2Dto,
  type W3Dto,
} from '@acct/shared';
import type { FederalTaxData } from '../tax/tax-data-types';
import { engineTaxGroups, sumKinds, sumTax, type EmployeeFacts, type PayRecord } from './records';

/**
 * Forms W-2 and W-3 from the year's pay records (ADR 0017), box by box as the 2026 General
 * Instructions for Forms W-2 and W-3 describe them. Pure: the service loads the records.
 */

const TIP_KINDS: PayrollItemKind[] = ['cash_tips', 'paid_tips'];
const RETIREMENT_KINDS: PayrollItemKind[] = [
  'traditional_401k',
  'traditional_403b',
  'roth_401k',
  'roth_403b',
  'retirement_match',
];
/** Box 12 codes from payroll item kinds (W-2 instructions pp.20–23). */
const BOX12_KINDS: { code: string; kinds: PayrollItemKind[] }[] = [
  { code: 'D', kinds: ['traditional_401k'] },
  { code: 'E', kinds: ['traditional_403b'] },
  // Employer contributions to an HSA, including employee contributions through a cafeteria plan.
  { code: 'W', kinds: ['hsa', 'employer_hsa', 'employer_hsa_cafeteria'] },
  { code: 'AA', kinds: ['roth_401k'] },
  { code: 'BB', kinds: ['roth_403b'] },
  // Cash tips reported to the employer; the occupation code goes in box 14b.
  { code: 'TP', kinds: TIP_KINDS },
];
/** W-3 box 12a: codes D through H, S, Y, AA, BB and EE (the ones payroll produces). */
const DEFERRED_COMP_CODES = ['D', 'E', 'AA', 'BB'];
const BOX14_TAXES: { code: PayrollTaxCode; label: string }[] = [
  { code: 'ca_sdi', label: 'CA SDI' },
  { code: 'ny_pfl', label: 'NY PFL' },
  { code: 'ny_dbl', label: 'NY DBL' },
];
const LOCALITIES: { code: PayrollTaxCode; state: string; locality: string }[] = [
  { code: 'nyc_income', state: 'NY', locality: 'NYC' },
  { code: 'yonkers_income', state: 'NY', locality: 'YONKERS' },
];

const m = (v: Money) => moneyToString(v);

/**
 * Code TT: the part of FLSA overtime pay above the regular rate ("only the 'half' portion of
 * 'time-and-a-half'"). For an overtime line at a multiple M of the regular rate that is
 * amount × min(M − 1, 0.5) ÷ M. Double time and overtime of exempt employees aren't counted.
 */
export function qualifiedOvertime(records: PayRecord[], overtimeExempt: boolean): Money {
  if (overtimeExempt) return ZERO;
  let total = ZERO;
  for (const r of records)
    for (const l of r.lines) {
      if (l.kind !== 'overtime' || !l.rateMultiplier) continue;
      const mult = parseMoney(l.rateMultiplier);
      const one = parseMoney('1');
      const half = parseMoney('0.5');
      const premium = mult - one < half ? mult - one : half;
      if (premium <= ZERO) continue;
      // amount × premium ÷ mult, rounded half up to the cent (100 units of 1/10,000).
      const denom = mult * 100n;
      total += ((l.amount * premium * 2n + denom) / (denom * 2n)) * 100n;
    }
  return total;
}

export interface W2Facts {
  federal: FederalTaxData;
  employees: EmployeeFacts[];
  /** The year's posted paychecks and prior payroll. */
  records: PayRecord[];
  /** State withholding account numbers by state (box 15). */
  stateIds: Record<string, string | null>;
}

export function buildW2s(f: W2Facts): W2Dto[] {
  const out: W2Dto[] = [];
  const base = parseMoney(f.federal.socialSecurity.wageBase);
  const maxSsTax =
    (base * parseMoney(f.federal.socialSecurity.employeeRatePercent)) / parseMoney('100');
  for (const e of f.employees) {
    const recs = f.records.filter((r) => r.employeeId === e.id);
    if (recs.length === 0) continue;
    const problems: string[] = [];
    const notes: string[] = [];

    // Boxes 3 and 7: social security wages and tips. Each paycheck's taxable social security
    // wages are split so tips (box 7) come out of that paycheck's total, capped by it.
    let box3 = ZERO;
    let box7 = ZERO;
    for (const r of recs) {
      const taxable = sumTax([r], ['social_security_employee'], 'taxableWages');
      const tips = sumKinds([r], TIP_KINDS);
      const t = tips < taxable ? tips : taxable;
      box7 += t;
      box3 += taxable - t;
    }
    const box1 = sumTax(recs, ['federal_income'], 'taxableWages');
    const box2 = sumTax(recs, ['federal_income'], 'amount');
    const box4 = sumTax(recs, ['social_security_employee'], 'amount');
    const box5 = sumTax(recs, ['medicare_employee'], 'taxableWages');
    const box6 = sumTax(recs, ['medicare_employee', 'additional_medicare'], 'amount');
    const box10 = sumKinds(recs, ['dependent_care_fsa']);

    const box12: W2Dto['box12'] = [];
    for (const { code, kinds } of BOX12_KINDS) {
      const amount = sumKinds(recs, kinds);
      if (amount > ZERO) box12.push({ code, amount: m(amount) });
    }
    const tt = qualifiedOvertime(recs, e.overtimeExempt);
    if (tt > ZERO) box12.push({ code: 'TT', amount: m(tt) });
    const retirementPlan = sumKinds(recs, RETIREMENT_KINDS) > ZERO;

    const box14a: W2Dto['box14a'] = [];
    for (const { code, label } of BOX14_TAXES) {
      const amount = sumTax(recs, [code], 'amount');
      if (amount > ZERO) box14a.push({ label, amount: m(amount) });
    }
    // A licensed engine's taxes (ADR 0026): local income taxes go in boxes 18–20; the employee's
    // other state and local taxes, and unemployment tax withheld, are listed in box 14.
    const engine = engineTaxGroups(recs, (l) =>
      l.taxCode === 'state_unemployment'
        ? `${l.state} UI`
        : (l.jurisdictionName ?? l.jurisdictionCode ?? ''),
    );
    for (const g of engine)
      if (g.payer === 'employee' && g.code !== 'local_income' && g.amount > ZERO)
        box14a.push({ label: g.label, amount: m(g.amount) });
    const hasTips = box12.some((b) => b.code === 'TP');
    const box14b = hasTips ? e.tippedOccupationCodes : null;

    const states: W2Dto['states'] = [];
    const stateCodes = [
      ...new Set(
        recs.flatMap((r) =>
          r.lines.filter((l) => l.taxCode === 'state_income' && l.state).map((l) => l.state!),
        ),
      ),
    ].sort();
    for (const s of stateCodes)
      states.push({
        state: s,
        employerStateId: f.stateIds[s] ?? null,
        wages: m(sumTax(recs, ['state_income'], 'taxableWages', s)),
        tax: m(sumTax(recs, ['state_income'], 'amount', s)),
      });
    const localities: W2Dto['localities'] = [];
    for (const l of LOCALITIES) {
      const lines = recs.flatMap((r) => r.lines.filter((x) => x.taxCode === l.code));
      if (lines.length === 0) continue;
      localities.push({
        state: l.state,
        locality: l.locality,
        wages: m(sumTax(recs, [l.code], 'taxableWages')),
        tax: m(sumTax(recs, [l.code], 'amount')),
      });
    }
    for (const g of engine)
      if (g.code === 'local_income')
        localities.push({
          state: g.state,
          locality: g.label,
          wages: m(g.taxableWages),
          tax: m(g.amount),
        });

    // The instructions' reconciliation rules (p.26) and what every W-2 needs.
    if (!e.hasSsn) problems.push("The employee's social security number is missing.");
    if (!e.address) problems.push("The employee's address is missing.");
    if (box3 + box7 > base)
      problems.push(`Boxes 3 and 7 are more than the $${m(base)} social security wage base.`);
    if (box4 > maxSsTax) problems.push(`Box 4 is more than $${m(maxSsTax)}.`);
    if (box4 > ZERO && box3 + box7 === ZERO)
      problems.push('Box 4 has social security tax but boxes 3 and 7 are zero.');
    if (box6 > ZERO && box5 === ZERO) problems.push('Box 6 has Medicare tax but box 5 is zero.');
    if (box5 < box3 + box7) problems.push('Box 5 is less than boxes 3 and 7.');
    if (hasTips && !e.tippedOccupationCodes)
      problems.push(
        "Box 14b needs the employee's Treasury tipped occupation code (reported tips, code TP).",
      );
    for (const s of states)
      if (!s.employerStateId)
        problems.push(`Box 15 needs your ${s.state} withholding account number (Payroll › Setup).`);
    for (const r of recs.filter((r) => r.source === 'prior'))
      if (
        r.lines.some((l) => l.lineType === 'earning') &&
        !r.lines.some((l) => l.taxCode === 'federal_income')
      )
        problems.push(
          `Prior payroll on ${r.payDate} has pay but no federal income tax line; box 1 needs its wages (enter 0 tax).`,
        );
    if (box12.length > 4)
      notes.push('More than four box 12 items: Copy A needs a second Form W-2 for the rest.');
    if (states.length > 2 || localities.length > 2)
      notes.push('More than two states or localities: file a second Form W-2 for the rest.');

    out.push({
      employeeId: e.id,
      employeeName: e.name,
      ssnMasked: e.ssnMasked,
      address: e.address,
      box1: m(box1),
      box2: m(box2),
      box3: m(box3),
      box4: m(box4),
      box5: m(box5),
      box6: m(box6),
      box7: m(box7),
      box10: m(box10),
      box12,
      retirementPlan,
      box14a,
      box14b,
      states,
      localities,
      problems,
      notes,
    });
  }
  return out;
}

export interface W3Facts {
  federalForm: '941' | '944';
  employerName: string;
  einLast4: string | null;
  hasAddress: boolean;
  /** The company's income tax form (form_990 means a 501(c) organization). */
  incomeTaxForm: string | null;
  stateIds: Record<string, string | null>;
}

export function buildW3(w2s: W2Dto[], f: W3Facts): W3Dto {
  const total = (pick: (w: W2Dto) => string) =>
    m(w2s.reduce((a, w) => a + parseMoney(pick(w)), ZERO));
  const states = [...new Set(w2s.flatMap((w) => w.states.map((s) => s.state)))];
  const problems: string[] = [];
  if (!f.einLast4) problems.push("Box e needs the company's EIN (Company settings).");
  if (!f.hasAddress) problems.push("Box g needs the company's address (Company settings).");
  const withProblems = w2s.filter((w) => w.problems.length).length;
  if (withProblems)
    problems.push(`${withProblems} Form${withProblems === 1 ? '' : 's'} W-2 still need fixing.`);
  const box12a = w2s.reduce(
    (a, w) =>
      a +
      w.box12
        .filter((b) => DEFERRED_COMP_CODES.includes(b.code))
        .reduce((x, b) => x + parseMoney(b.amount), ZERO),
    ZERO,
  );
  return {
    kindOfPayer: f.federalForm,
    kindOfEmployer: f.incomeTaxForm?.startsWith('form_990') ? '501c non-govt.' : 'None apply',
    count: w2s.length,
    employerName: f.employerName,
    einLast4: f.einLast4,
    box1: total((w) => w.box1),
    box2: total((w) => w.box2),
    box3: total((w) => w.box3),
    box4: total((w) => w.box4),
    box5: total((w) => w.box5),
    box6: total((w) => w.box6),
    box7: total((w) => w.box7),
    box10: total((w) => w.box10),
    box12a: m(box12a),
    state: states.length === 0 ? null : states.length === 1 ? states[0]! : 'X',
    employerStateId: states.length === 1 ? (f.stateIds[states[0]!] ?? null) : null,
    box16: m(
      w2s.reduce((a, w) => a + w.states.reduce((x, s) => x + parseMoney(s.wages), ZERO), ZERO),
    ),
    box17: m(
      w2s.reduce((a, w) => a + w.states.reduce((x, s) => x + parseMoney(s.tax), ZERO), ZERO),
    ),
    box18: m(
      w2s.reduce((a, w) => a + w.localities.reduce((x, s) => x + parseMoney(s.wages), ZERO), ZERO),
    ),
    box19: m(
      w2s.reduce((a, w) => a + w.localities.reduce((x, s) => x + parseMoney(s.tax), ZERO), ZERO),
    ),
    problems,
  };
}
