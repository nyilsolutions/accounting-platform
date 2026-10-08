import {
  PAYROLL_ITEM_KINDS,
  WORK_STATE_NAMES,
  ZERO,
  isPayrollState,
  moneyToString,
  parseMoney,
  type Money,
  type PayFrequency,
  type PayrollItemKind,
  type WorkState,
} from '@acct/shared';

/**
 * A licensed state and local payroll tax engine (ADR 0026). The built-in engine
 * (`tax-engine.ts`) calculates federal taxes and the five states it has tax-data for. Any other
 * state's taxes, and local taxes there, come from an engine behind this interface:
 *
 * - tests use `FixtureStateTaxEngine`, whose figures each test programs (`PAYROLL_TAX_ENGINE`
 *   'test-fixture', refused outside NODE_ENV=test);
 * - a licensed engine (an embedded provider's SDK or service) implements it once one is
 *   contracted. Until then such paychecks are refused with the reason: there is no stand-in,
 *   so no invented tax amount ever reaches a paycheck.
 *
 * Requests never carry the SSN or any bank number. Every answer is checked
 * (`checkStateTaxAnswer`) before a line reaches a paycheck.
 */
export interface StateTaxEngine {
  /** Shown in refusals and notices, e.g. 'Test fixture'. */
  readonly name: string;
  /** Whether the engine calculates this state's payroll taxes. */
  supports(state: WorkState): boolean;
  calculate(request: StateTaxRequest): Promise<StateTaxAnswer>;
}

export const STATE_TAX_ENGINE = Symbol('STATE_TAX_ENGINE');

export const STATE_TAX_ENGINE_CODES = [
  'state_income',
  'state_unemployment',
  'state_other',
  'local_income',
  'local_other',
] as const;
export type StateTaxEngineCode = (typeof STATE_TAX_ENGINE_CODES)[number];

export interface StateTaxAddress {
  line1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
}

export interface StateTaxRequest {
  payDate: string;
  frequency: PayFrequency;
  workState: WorkState;
  workAddress: StateTaxAddress;
  homeAddress: StateTaxAddress;
  /** Earnings, deductions and company contributions, as positive decimal strings. */
  items: { kind: PayrollItemKind; amount: string }[];
  /** Supplemental wages paid separately (a bonus check). */
  supplemental: boolean;
  /** The employer's unemployment rate for the year in the work state (percent), if entered. */
  unemploymentRatePercent: string | null;
  /** This calendar year's earlier taxes, by code, state and jurisdiction. */
  ytd: StateTaxYtd[];
}

export interface StateTaxYtd {
  code: StateTaxEngineCode;
  payer: 'employee' | 'employer';
  state: string;
  jurisdictionCode: string | null;
  taxableWages: string;
  subjectWages: string;
  amount: string;
}

export interface StateTaxEngineLine {
  code: StateTaxEngineCode;
  payer: 'employee' | 'employer';
  state: string;
  /** Required for state_other, local_income and local_other; null for the others. */
  jurisdiction: { code: string; name: string } | null;
  taxableWages: string;
  subjectWages: string;
  amount: string;
}

export type StateTaxAnswer =
  | { lines: StateTaxEngineLine[]; notices: string[] }
  /** The engine can't calculate this paycheck; the reasons are shown to the payroll admin. */
  | { refused: string[] };

/** A checked line, ready for the paycheck. */
export interface CheckedStateTaxLine {
  code: StateTaxEngineCode;
  payer: 'employee' | 'employer';
  state: WorkState;
  jurisdiction: { code: string; name: string } | null;
  taxableWages: Money;
  subjectWages: Money;
  amount: Money;
}

export type CheckedStateTaxes = { lines: CheckedStateTaxLine[]; notices: string[] };

const JURISDICTION_CODE = /^[A-Za-z0-9_.-]{1,40}$/;
const MONEY = /^\d{1,13}(\.\d{1,2})?$/;

/**
 * Checks an engine's answer before any of it reaches a paycheck: known codes, the work state,
 * a named jurisdiction exactly where one is needed, and non-negative amounts to the cent. A
 * single bad line refuses the whole answer.
 */
export function checkStateTaxAnswer(
  engine: string,
  request: StateTaxRequest,
  answer: StateTaxAnswer,
): CheckedStateTaxes | { refused: string[] } {
  if ('refused' in answer) {
    const reasons = answer.refused.filter((r) => typeof r === 'string' && r.trim());
    return {
      refused: (reasons.length ? reasons : ['No reason was given.']).map(
        (r) => `${engine}: ${r.trim()}`,
      ),
    };
  }
  const problems: string[] = [];
  const lines: CheckedStateTaxLine[] = [];
  const seen = new Set<string>();
  const stateName = WORK_STATE_NAMES[request.workState];
  for (const [i, l] of (answer.lines ?? []).entries()) {
    const at = `line ${i + 1}`;
    if (!(STATE_TAX_ENGINE_CODES as readonly string[]).includes(l.code)) {
      problems.push(`${at} has an unknown tax code.`);
      continue;
    }
    if (l.payer !== 'employee' && l.payer !== 'employer') {
      problems.push(`${at} doesn't say who pays it.`);
      continue;
    }
    if (l.code === 'state_income' && l.payer !== 'employee') {
      problems.push(`${at}: state income tax is withheld from the employee.`);
      continue;
    }
    if (l.state !== request.workState) {
      problems.push(`${at} is for another state than ${stateName}.`);
      continue;
    }
    const needsJurisdiction = l.code !== 'state_income' && l.code !== 'state_unemployment';
    const j = l.jurisdiction;
    if (needsJurisdiction) {
      if (
        !j ||
        typeof j.code !== 'string' ||
        !JURISDICTION_CODE.test(j.code) ||
        typeof j.name !== 'string' ||
        !j.name.trim() ||
        j.name.trim().length > 80
      ) {
        problems.push(`${at} doesn't name its jurisdiction.`);
        continue;
      }
    } else if (j) {
      problems.push(`${at}: state income and unemployment taxes don't have a jurisdiction.`);
      continue;
    }
    const money = [l.taxableWages, l.subjectWages, l.amount];
    if (!money.every((m) => typeof m === 'string' && MONEY.test(m))) {
      problems.push(`${at} has an amount that isn't dollars and cents.`);
      continue;
    }
    const key = `${l.code}|${l.payer}|${j?.code ?? ''}`;
    if (seen.has(key)) {
      problems.push(`${at} repeats a tax.`);
      continue;
    }
    seen.add(key);
    lines.push({
      code: l.code,
      payer: l.payer,
      state: request.workState,
      jurisdiction: needsJurisdiction ? { code: j!.code, name: j!.name.trim() } : null,
      taxableWages: parseMoney(l.taxableWages),
      subjectWages: parseMoney(l.subjectWages),
      amount: parseMoney(l.amount),
    });
  }
  if (problems.length)
    return { refused: problems.map((p) => `${engine}'s answer can't be used: ${p}`) };
  const notices = (answer.notices ?? []).filter((n) => typeof n === 'string' && n.trim());
  return { lines, notices: notices.map((n) => n.trim()) };
}

/** The reason a paycheck in a state without a built-in engine is refused when none is set up. */
export function noEngineReason(state: WorkState): string {
  return `${WORK_STATE_NAMES[state]} payroll taxes aren't built in. They need a licensed tax engine, and none is set up on this platform yet.`;
}

/** Asks the engine, checking its answer; an engine that throws refuses the paycheck. */
export async function askStateTaxEngine(
  engine: StateTaxEngine | null,
  request: StateTaxRequest,
): Promise<CheckedStateTaxes | { refused: string[] }> {
  if (isPayrollState(request.workState))
    throw new Error(`${request.workState} taxes are calculated by the built-in engine`);
  if (!engine || !engine.supports(request.workState))
    return { refused: [noEngineReason(request.workState)] };
  let answer: StateTaxAnswer;
  try {
    answer = await engine.calculate(request);
  } catch {
    // The engine's message may echo the request: it isn't shown or logged.
    return {
      refused: [
        `${engine.name} didn't answer for ${WORK_STATE_NAMES[request.workState]}. Try again shortly.`,
      ],
    };
  }
  return checkStateTaxAnswer(engine.name, request, answer);
}

// ---- The test fixture -------------------------------------------------------------------------

/**
 * One programmed tax: `ratePercent` of the paycheck's earnings (less pre-tax deductions when
 * `lessPreTax`), up to `wageBase` a year counting earlier paychecks. Tests supply every figure;
 * none of it is tax law.
 */
export interface FixtureTaxRule {
  code: StateTaxEngineCode;
  payer: 'employee' | 'employer';
  jurisdiction?: { code: string; name: string };
  ratePercent: string;
  wageBase?: string;
  lessPreTax?: boolean;
  /** Only for employees whose work address is in this city. */
  workCity?: string;
}

/**
 * The engine tests use (NODE_ENV=test only). It calculates nothing until a test programs a
 * state, and keeps every request so tests can see what an engine is sent.
 */
export class FixtureStateTaxEngine implements StateTaxEngine {
  readonly name = 'Test fixture';
  readonly requests: StateTaxRequest[] = [];
  private readonly states = new Map<WorkState, FixtureTaxRule[] | { refused: string[] }>();
  private failing = false;

  program(state: WorkState, rules: FixtureTaxRule[] | { refused: string[] }) {
    this.states.set(state, rules);
  }

  /** Makes every calculation throw, as an engine that is down. */
  fail(failing = true) {
    this.failing = failing;
  }

  reset() {
    this.states.clear();
    this.requests.length = 0;
    this.failing = false;
  }

  supports(state: WorkState): boolean {
    return this.states.has(state);
  }

  async calculate(request: StateTaxRequest): Promise<StateTaxAnswer> {
    this.requests.push(structuredClone(request));
    if (this.failing) throw new Error('fixture engine is down');
    const rules = this.states.get(request.workState);
    if (!rules) return { refused: [`${request.workState} isn't programmed.`] };
    if ('refused' in rules) return rules;
    const cents = (s: string) => parseMoney(s);
    let wages = ZERO;
    let preTax = ZERO;
    for (const i of request.items) {
      const category = PAYROLL_ITEM_KINDS[i.kind].category;
      if (category === 'earning') wages += cents(i.amount);
      if (category === 'pre_tax_deduction') preTax += cents(i.amount);
    }
    const lines: StateTaxEngineLine[] = [];
    for (const r of rules) {
      if (r.workCity && r.workCity !== request.workAddress.city) continue;
      const subject = r.lessPreTax ? (wages > preTax ? wages - preTax : ZERO) : wages;
      let taxable = subject;
      if (r.wageBase !== undefined) {
        const before = request.ytd
          .filter(
            (y) =>
              y.code === r.code &&
              y.payer === r.payer &&
              y.jurisdictionCode === (r.jurisdiction?.code ?? null),
          )
          .reduce((a, y) => a + cents(y.taxableWages), ZERO);
        const room = cents(r.wageBase) - before;
        taxable = room <= ZERO ? ZERO : taxable < room ? taxable : room;
      }
      // Money is in ten-thousandths and ratePercent has at most four decimals:
      // amount = taxable * rate / 100, rounded to the cent.
      const [whole, frac = ''] = r.ratePercent.split('.');
      const rate = BigInt(whole! + frac.padEnd(4, '0'));
      const amount = ((taxable * rate + 50_000_000n) / 100_000_000n) * 100n;
      lines.push({
        code: r.code,
        payer: r.payer,
        state: request.workState,
        jurisdiction: r.jurisdiction ?? null,
        taxableWages: moneyToString(taxable),
        subjectWages: moneyToString(subject),
        amount: moneyToString(amount),
      });
    }
    return { lines, notices: [] };
  }
}
