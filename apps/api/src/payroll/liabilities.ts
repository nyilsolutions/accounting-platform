import {
  ZERO,
  addDays,
  monthEndOf,
  monthStartOf,
  moneyToString,
  parseMoney,
  payrollTaxLabel,
  weekday,
  WORK_STATE_NAMES,
  type Money,
  type PayrollLiabilityDto,
  type PayrollLiabilityStatus,
  type PayrollTaxCode,
} from '@acct/shared';
import type {
  DepositRules,
  FederalTaxData,
  StateDepositRules,
  StateTaxData,
} from './tax/tax-data-types';

/**
 * Payroll liabilities by agency and deposit period, with due dates (ADR 0016). Pure: the service
 * loads posted paycheck lines and payments. Deposit rules come from tax-data (federal.json
 * `deposits` and `futa`, a state's `withholdingDeposits` and `quarterlyReturns`); state due dates
 * only where the state file has them.
 *
 * Due dates falling on a weekend move to the Monday after; federal and state holidays are not
 * applied yet (docs/open-questions.md, item 46).
 */

export interface LiabilityLine {
  payDate: string;
  lineType: 'tax' | 'deduction' | 'contribution';
  taxCode: PayrollTaxCode | null;
  state: string | null;
  /** A licensed engine's jurisdiction (state_other, local_income, local_other; ADR 0026). */
  jurisdictionCode?: string | null;
  jurisdictionName?: string | null;
  payrollItemId: string | null;
  itemName: string | null;
  amount: Money;
}

export interface LiabilityPayment {
  agency: string;
  periodStart: string;
  periodEnd: string;
  amount: Money;
}

export interface LiabilityFacts {
  /** The year's federal tax data (deposit rules and FUTA), if there is any. */
  federal: (year: number) => FederalTaxData | undefined;
  /** State files by year and state, for due dates (e.g. California's DE 9 dates). */
  states: (year: number, state: string) => StateTaxData | undefined;
  depositSchedule: 'monthly' | 'semiweekly';
  /** The withholding deposit schedule each state assigned, by state (null: not set). */
  stateDepositSchedules?: Partial<Record<string, 'monthly' | 'semiweekly' | null>>;
  lines: LiabilityLine[];
  payments: LiabilityPayment[];
  today: string;
}

const FEDERAL_941: PayrollTaxCode[] = [
  'federal_income',
  'social_security_employee',
  'social_security_employer',
  'medicare_employee',
  'medicare_employer',
  'additional_medicare',
];
const STATE_WITHHOLDING: PayrollTaxCode[] = [
  'state_income',
  'nyc_income',
  'yonkers_income',
  'ca_sdi',
];
const STATE_UNEMPLOYMENT: PayrollTaxCode[] = [
  'state_unemployment',
  'ny_reemployment_fund',
  'ca_ett',
];
const STATE_NAMES: Record<string, string> = WORK_STATE_NAMES;

/** The agency a paycheck line is owed to. */
export function agencyOf(
  l: Pick<LiabilityLine, 'lineType' | 'taxCode' | 'state' | 'payrollItemId' | 'jurisdictionCode'>,
): string {
  if (l.lineType !== 'tax') return `item:${l.payrollItemId}`;
  const code = l.taxCode!;
  if (FEDERAL_941.includes(code)) return 'federal_941';
  if (code === 'futa') return 'federal_940';
  if (code === 'ny_pfl') return 'ny_pfl';
  if (code === 'ny_dbl') return 'ny_dbl';
  if (STATE_WITHHOLDING.includes(code)) return `state_withholding:${l.state}`;
  if (STATE_UNEMPLOYMENT.includes(code)) return `state_unemployment:${l.state}`;
  // A licensed engine's other state and local taxes: owed to each jurisdiction.
  if (code === 'state_other') return `state_other:${l.state}:${l.jurisdictionCode}`;
  if (code === 'local_income' || code === 'local_other')
    return `local:${l.state}:${l.jurisdictionCode}`;
  throw new Error(`No agency for ${code}`);
}

/**
 * An agency's name. `names` has payroll items by id and, for a licensed engine's jurisdictions,
 * their names by agency (e.g. 'local:PA:510101' → 'Philadelphia').
 */
export function agencyLabel(agency: string, itemNames: Map<string, string>): string {
  if (agency === 'federal_941')
    return 'IRS: Form 941 taxes (income tax, social security, Medicare)';
  if (agency === 'federal_940') return 'IRS: Form 940 (FUTA)';
  if (agency === 'ny_pfl') return 'New York Paid Family Leave (your carrier)';
  if (agency === 'ny_dbl') return 'New York disability benefits (your carrier)';
  const [kind, rest, jurisdiction] = agency.split(':') as [string, string, string?];
  if (kind === 'state_other' || kind === 'local')
    return `${STATE_NAMES[rest] ?? rest}: ${itemNames.get(agency) ?? (kind === 'local' ? `local tax ${jurisdiction}` : `state tax ${jurisdiction}`)}`;
  if (kind === 'state_withholding') return `${STATE_NAMES[rest] ?? rest}: income tax withholding`;
  if (kind === 'state_unemployment') return `${STATE_NAMES[rest] ?? rest}: unemployment`;
  return itemNames.get(rest) ?? 'Payroll item';
}

/** The next weekday on or after `d`. */
function onBusinessDay(d: string): string {
  const w = weekday(d);
  return w === 6 ? addDays(d, 2) : w === 0 ? addDays(d, 1) : d;
}
function nextBusinessDay(d: string): string {
  return onBusinessDay(addDays(d, 1));
}
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
/** "following Wednesday" → 3. */
function weekdayIn(text: string): number {
  const i = WEEKDAYS.findIndex((w) => text.toLowerCase().includes(w));
  if (i < 0) throw new Error(`No weekday in "${text}"`);
  return i;
}
function followingWeekday(d: string, target: number): string {
  let out = addDays(d, 1);
  while (weekday(out) !== target) out = addDays(out, 1);
  return out;
}

/** The semiweekly deposit period (Wednesday–Friday or Saturday–Tuesday) holding `d`, and its due date. */
function semiweeklyPeriod(d: string, rules: Pick<DepositRules, 'semiweekly'>) {
  const w = weekday(d);
  if (w >= 3 && w <= 5) {
    const start = addDays(d, 3 - w);
    const end = addDays(start, 2);
    return {
      start,
      end,
      due: followingWeekday(end, weekdayIn(rules.semiweekly.wednesday_to_friday)),
    };
  }
  // Saturday (6) to Tuesday (2).
  const back = w === 6 ? 0 : w + 1;
  const start = addDays(d, -back);
  const end = addDays(start, 3);
  return {
    start,
    end,
    due: followingWeekday(end, weekdayIn(rules.semiweekly.saturday_to_tuesday)),
  };
}

function quarterOf(d: string) {
  const y = Number(d.slice(0, 4));
  const q = Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1;
  const startMonth = String((q - 1) * 3 + 1).padStart(2, '0');
  const start = `${y}-${startMonth}-01`;
  const end = monthEndOf(`${y}-${String(q * 3).padStart(2, '0')}-01`);
  return { year: y, q, start, end };
}

/** A state withholding deposit period holding `d` and its due date; never spans two quarters. */
function stateDepositGroup(
  d: string,
  schedule: 'monthly' | 'semiweekly',
  rules: StateDepositRules,
  quarter: ReturnType<typeof quarterOf>,
) {
  if (schedule === 'monthly') {
    const next = addDays(monthEndOf(d), 1);
    const due = `${next.slice(0, 7)}-${String(rules.monthlyDueDayOfFollowingMonth).padStart(2, '0')}`;
    return { start: monthStartOf(d), end: monthEndOf(d), due: onBusinessDay(due) };
  }
  const p = semiweeklyPeriod(d, rules);
  return {
    start: p.start < quarter.start ? quarter.start : p.start,
    end: p.end > quarter.end ? quarter.end : p.end,
    due: onBusinessDay(p.due),
  };
}

function ordinal(n: number): string {
  const suffix =
    n % 10 === 1 && n !== 11
      ? 'st'
      : n % 10 === 2 && n !== 12
        ? 'nd'
        : n % 10 === 3 && n !== 13
          ? 'rd'
          : 'th';
  return `${n}${suffix}`;
}

interface Group {
  agency: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string | null;
  dueNote: string | null;
  nextDay: boolean;
  parts: Map<string, Money>;
  accrued: Money;
}

export function payrollLiabilities(
  f: LiabilityFacts,
  itemNames: Map<string, string>,
): {
  rows: PayrollLiabilityDto[];
  effectiveSchedule: 'monthly' | 'semiweekly';
} {
  const groups = new Map<string, Group>();
  const group = (agency: string, start: string, end: string, init: Partial<Group> = {}) => {
    const key = `${agency}|${start}|${end}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        agency,
        periodStart: start,
        periodEnd: end,
        dueDate: null,
        dueNote: null,
        nextDay: false,
        parts: new Map(),
        accrued: ZERO,
        ...init,
      };
      groups.set(key, g);
    }
    return g;
  };
  const addPart = (g: Group, label: string, amount: Money) => {
    g.parts.set(label, (g.parts.get(label) ?? ZERO) + amount);
    g.accrued += amount;
  };
  const partLabel = (l: LiabilityLine) =>
    l.lineType === 'tax'
      ? payrollTaxLabel(l.taxCode!, l.state, l.jurisdictionName)
      : (l.itemName ?? 'Payroll item');

  // --- Form 941 taxes: monthly or semiweekly, with the $100,000 next-day rule. -----------------
  let effective: 'monthly' | 'semiweekly' = f.depositSchedule;
  const byYear = new Map<number, LiabilityLine[]>();
  for (const l of f.lines.filter((l) => agencyOf(l) === 'federal_941')) {
    const y = Number(l.payDate.slice(0, 4));
    byYear.set(y, [...(byYear.get(y) ?? []), l]);
  }
  for (const [year, lines] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
    const fed = f.federal(year);
    if (!fed) {
      for (const l of lines) {
        const g = group('federal_941', l.payDate, l.payDate, {
          dueNote: `There is no ${year} federal tax data, so the due date isn't known.`,
        });
        addPart(g, partLabel(l), l.amount);
      }
      continue;
    }
    const rules = fed.deposits;
    const threshold = parseMoney(rules.nextDayThreshold);
    let schedule: 'monthly' | 'semiweekly' = f.depositSchedule;
    const payDates = [...new Set(lines.map((l) => l.payDate))].sort();
    // Undeposited liability accumulated in the current deposit period (for the $100,000 rule).
    let periodKey = '';
    let accumulated = ZERO;
    for (const d of payDates) {
      const dayLines = lines.filter((l) => l.payDate === d);
      const dayTotal = dayLines.reduce((a, l) => a + l.amount, ZERO);
      const period =
        schedule === 'monthly'
          ? { start: monthStartOf(d), end: monthEndOf(d), due: null as string | null }
          : semiweeklyPeriod(d, rules);
      const key = `${period.start}|${period.end}`;
      if (key !== periodKey) {
        periodKey = key;
        accumulated = ZERO;
      }
      accumulated += dayTotal;
      let g: Group;
      if (accumulated >= threshold) {
        // Deposit everything accumulated by the next business day; a monthly depositor becomes
        // semiweekly for the rest of the year (and the next).
        g = group('federal_941', d, d, {
          dueDate: nextBusinessDay(d),
          nextDay: true,
          dueNote: '$100,000 or more accumulated: deposit by the next business day.',
        });
        accumulated = ZERO;
        schedule = 'semiweekly';
        if (year >= Number(f.today.slice(0, 4)) - 1) effective = 'semiweekly';
      } else if (schedule === 'monthly') {
        const next = addDays(period.end, 1);
        const due = onBusinessDay(
          `${next.slice(0, 7)}-${String(rules.monthlyDueDayOfFollowingMonth).padStart(2, '0')}`,
        );
        g = group('federal_941', period.start, period.end, { dueDate: due });
      } else {
        g = group('federal_941', period.start, period.end, { dueDate: onBusinessDay(period.due!) });
      }
      for (const l of dayLines) addPart(g, partLabel(l), l.amount);
    }
  }

  // --- FUTA: quarterly, deposited once more than $500 has accumulated. -------------------------
  // A quarter at $500 or less carries forward: it is deposited with the first later quarter that
  // takes the running total over $500, or with the fourth quarter's by January 31.
  const futa = f.lines.filter((l) => agencyOf(l) === 'federal_940');
  const futaYears = [...new Set(futa.map((l) => Number(l.payDate.slice(0, 4))))].sort();
  for (const year of futaYears) {
    const fed = f.federal(year);
    const quarters: { q: number; amount: Money; g: Group }[] = [];
    for (let q = 1; q <= 4; q++) {
      const lines = futa.filter(
        (l) => Number(l.payDate.slice(0, 4)) === year && quarterOf(l.payDate).q === q,
      );
      if (lines.length === 0) continue;
      const { start, end } = quarterOf(`${year}-${String(q * 3).padStart(2, '0')}-01`);
      const g = group('federal_940', start, end);
      for (const l of lines) addPart(g, partLabel(l), l.amount);
      quarters.push({ q, amount: lines.reduce((a, l) => a + l.amount, ZERO), g });
    }
    if (!fed) {
      for (const { g } of quarters)
        g.dueNote = `There is no ${year} federal tax data, so the due date isn't known.`;
      continue;
    }
    const threshold = parseMoney(fed.futa.quarterlyDepositThreshold);
    const dueOf = (quarter: number) =>
      onBusinessDay(
        `${quarter === 4 ? year + 1 : year}-${fed.futa.depositDue[`Q${quarter}` as 'Q1']}`,
      );
    let waiting: typeof quarters = [];
    let carried = ZERO;
    for (const quarter of quarters) {
      waiting.push(quarter);
      carried += quarter.amount;
      if (quarter.q === 4 || carried > threshold) {
        for (const w of waiting) {
          w.g.dueDate = dueOf(quarter.q);
          if (w.q !== quarter.q)
            w.g.dueNote = `Carried forward (under $${moneyToString(threshold)}): deposit with Q${quarter.q}.`;
        }
        waiting = [];
        carried = ZERO;
      }
    }
    // Still at $500 or less: due when a later quarter passes $500, and by January 31 at the latest.
    for (const w of waiting) {
      w.g.dueDate = dueOf(4);
      w.g.dueNote = `Under $${moneyToString(threshold)} so far: carried forward until a quarter takes the year's undeposited FUTA over $${moneyToString(threshold)}, and due by January 31 at the latest.`;
    }
  }

  // --- State withholding with a deposit schedule in tax-data (Illinois). -------------------------
  const scheduled = new Set<string>();
  const byState = new Map<string, LiabilityLine[]>();
  for (const l of f.lines) {
    const agency = agencyOf(l);
    if (!agency.startsWith('state_withholding:')) continue;
    const rules = f.states(Number(l.payDate.slice(0, 4)), l.state!)?.withholdingDeposits;
    if (!rules) continue;
    scheduled.add(`${agency}|${l.payDate}`);
    byState.set(l.state!, [...(byState.get(l.state!) ?? []), l]);
  }
  for (const [state, lines] of byState) {
    const assigned = f.stateDepositSchedules?.[state] ?? null;
    // More than the threshold withheld in a quarter: semiweekly from the next quarter through
    // the end of the following year.
    let semiweeklyFrom: { from: string; until: string; note: string } | null = null;
    const quarterTotals = new Map<string, Money>();
    const payDates = [...new Set(lines.map((l) => l.payDate))].sort();
    for (const d of payDates) {
      const rules = f.states(Number(d.slice(0, 4)), state)!.withholdingDeposits!;
      const quarter = quarterOf(d);
      const base = assigned ?? rules.newTaxpayerSchedule;
      const switched = semiweeklyFrom && d >= semiweeklyFrom.from && d <= semiweeklyFrom.until;
      const schedule = switched ? 'semiweekly' : base;
      const dayLines = lines.filter((l) => l.payDate === d);
      const g = stateDepositGroup(d, schedule, rules, quarter);
      const name = STATE_NAMES[state] ?? state;
      const grp = group(`state_withholding:${state}`, g.start, g.end, {
        dueDate: g.due,
        dueNote: switched
          ? semiweeklyFrom!.note
          : schedule === 'monthly'
            ? `${name} monthly schedule: due the ${ordinal(rules.monthlyDueDayOfFollowingMonth)} of the following month.`
            : `${name} semiweekly schedule: pay electronically.`,
      });
      for (const l of dayLines) addPart(grp, partLabel(l), l.amount);
      if (rules.quarterThreshold && schedule === 'monthly' && !switched) {
        const key = `Q${quarter.q}-${quarter.year}`;
        const total =
          (quarterTotals.get(key) ?? ZERO) + dayLines.reduce((a, l) => a + l.amount, ZERO);
        quarterTotals.set(key, total);
        if (total > parseMoney(rules.quarterThreshold)) {
          semiweeklyFrom = {
            from: addDays(quarter.end, 1),
            until: `${quarter.year + 1}-12-31`,
            note: `More than $${moneyToString(parseMoney(rules.quarterThreshold))} was withheld in Q${quarter.q} ${quarter.year}: ${name} semiweekly schedule from the next quarter through ${quarter.year + 1}.`,
          };
        }
      }
    }
  }

  // --- State and local: by quarter. --------------------------------------------------------------
  for (const l of f.lines) {
    const agency = agencyOf(l);
    if (agency.startsWith('federal_') || agency.startsWith('item:')) continue;
    if (scheduled.has(`${agency}|${l.payDate}`)) continue;
    const { year, q, start, end } = quarterOf(l.payDate);
    const g = group(agency, start, end);
    addPart(g, partLabel(l), l.amount);
    if (g.dueDate || g.dueNote) continue;
    const state = agency.includes(':') ? agency.split(':')[1]! : 'NY';
    const data = f.states(year, state);
    if (agency.startsWith('state_other:') || agency.startsWith('local:')) {
      g.dueNote = `${l.jurisdictionName ?? 'This tax'}: its deposit and return due dates aren't in tax-data; check with the agency or your tax engine provider.`;
    } else if (agency.startsWith('state_unemployment:')) {
      const returns = data?.quarterlyReturns;
      const due = (returns?.dueDates ?? returns?.delinquentDates)?.[`Q${q}`];
      if (due) {
        g.dueDate = due;
        g.dueNote = returns!.dueNote ?? null;
      } else
        g.dueNote = `Due with ${STATE_NAMES[state] ?? state}'s quarterly unemployment return; its due date isn't in tax-data yet.`;
    } else if (agency === 'ny_pfl' || agency === 'ny_dbl') {
      g.dueNote =
        agency === 'ny_pfl'
          ? 'Pay your Paid Family Leave insurance carrier as it bills you.'
          : 'Pay your disability benefits insurance carrier as it bills you.';
    } else {
      g.dueNote = `${STATE_NAMES[state] ?? state}'s withholding deposit schedule isn't in tax-data yet; check your state notice.`;
    }
  }

  // --- Deductions and company contributions: due to the payee on the pay date. -----------------
  for (const l of f.lines) {
    if (l.lineType === 'tax') continue;
    const g = group(agencyOf(l), l.payDate, l.payDate, { dueDate: l.payDate });
    addPart(g, partLabel(l), l.amount);
  }

  // --- Payments and status. -----------------------------------------------------------------------
  const paid = new Map<string, Money>();
  for (const p of f.payments) {
    const key = `${p.agency}|${p.periodStart}|${p.periodEnd}`;
    paid.set(key, (paid.get(key) ?? ZERO) + p.amount);
  }
  const soon = addDays(f.today, 7);
  const rows = [...groups.entries()].map(([key, g]): PayrollLiabilityDto => {
    const p = paid.get(key) ?? ZERO;
    const balance = g.accrued - p;
    const status: PayrollLiabilityStatus =
      balance <= ZERO
        ? 'paid'
        : !g.dueDate
          ? 'no_due_date'
          : g.dueDate < f.today
            ? 'overdue'
            : g.dueDate <= soon
              ? 'due_soon'
              : 'open';
    return {
      agency: g.agency,
      agencyLabel: agencyLabel(g.agency, itemNames),
      periodStart: g.periodStart,
      periodEnd: g.periodEnd,
      dueDate: g.dueDate,
      dueNote: g.dueNote,
      nextDay: g.nextDay,
      accrued: moneyToString(g.accrued),
      paid: moneyToString(p),
      balance: moneyToString(balance),
      status,
      parts: [...g.parts.entries()].map(([label, amount]) => ({
        label,
        amount: moneyToString(amount),
      })),
    };
  });
  // Payments recorded against a period that no longer has lines (e.g. its paychecks were voided).
  for (const [key, amount] of paid) {
    if (groups.has(key)) continue;
    const [agency, periodStart, periodEnd] = key.split('|') as [string, string, string];
    rows.push({
      agency,
      agencyLabel: agencyLabel(agency, itemNames),
      periodStart,
      periodEnd,
      dueDate: null,
      dueNote: 'Paid, but no posted paychecks owe this now (were they voided?).',
      nextDay: false,
      accrued: '0.00',
      paid: moneyToString(amount),
      balance: moneyToString(-amount),
      status: 'paid',
      parts: [],
    });
  }
  rows.sort(
    (a, b) =>
      (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') ||
      a.periodStart.localeCompare(b.periodStart) ||
      a.agency.localeCompare(b.agency),
  );
  return { rows, effectiveSchedule: effective };
}
