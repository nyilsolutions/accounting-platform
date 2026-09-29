/** Accounting dates are plain 'YYYY-MM-DD' strings with no time zone. */
export type IsoDate = string;

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(s: string): boolean {
  const m = ISO.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return (
    d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!
  );
}

function parts(date: IsoDate): [number, number, number] {
  const m = ISO.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  return [+m[1]!, +m[2]!, +m[3]!];
}

function fmt(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const [y, m, d] = parts(date);
  return fmt(new Date(Date.UTC(y, m - 1, d + days)));
}

export function todayIso(now: Date = new Date()): IsoDate {
  // The user's local calendar date, not UTC.
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function monthStart(y: number, m: number): IsoDate {
  return fmt(new Date(Date.UTC(y, m - 1, 1)));
}

function monthEnd(y: number, m: number): IsoDate {
  return fmt(new Date(Date.UTC(y, m, 0)));
}

/** First day of the month containing `date`. */
export function monthStartOf(date: IsoDate): IsoDate {
  const [y, m] = parts(date);
  return monthStart(y, m);
}

/** Last day of the month containing `date`. */
export function monthEndOf(date: IsoDate): IsoDate {
  const [y, m] = parts(date);
  return monthEnd(y, m);
}

/** The same day `n` months later (or earlier), clamped to the month's last day. */
export function addMonths(date: IsoDate, n: number): IsoDate {
  const [y, m, d] = parts(date);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return fmt(new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))));
}

/** Day of the week, 0 = Sunday. */
export function weekday(date: IsoDate): number {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** First day of the fiscal year containing `date` (fiscal year starts on the 1st of `startMonth`). */
export function fiscalYearStart(date: IsoDate, startMonth: number): IsoDate {
  const [y, m] = parts(date);
  return monthStart(m >= startMonth ? y : y - 1, startMonth);
}

export function fiscalYearEnd(date: IsoDate, startMonth: number): IsoDate {
  const start = fiscalYearStart(date, startMonth);
  const [y, m] = parts(start);
  return addDays(monthStart(y + 1, m), -1);
}

export const DATE_PRESETS = [
  'today',
  'this_week',
  'last_week',
  'last_30_days',
  'this_month',
  'last_month',
  'this_fiscal_quarter',
  'last_fiscal_quarter',
  'this_fiscal_year',
  'this_fiscal_year_to_date',
  'last_fiscal_year',
] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  today: 'Today',
  this_week: 'This week',
  last_week: 'Last week',
  last_30_days: 'Last 30 days',
  this_month: 'This month',
  last_month: 'Last month',
  this_fiscal_quarter: 'This fiscal quarter',
  last_fiscal_quarter: 'Last fiscal quarter',
  this_fiscal_year: 'This fiscal year',
  this_fiscal_year_to_date: 'This fiscal year to date',
  last_fiscal_year: 'Last fiscal year',
};

export function presetRange(
  preset: DatePreset,
  today: IsoDate,
  fyStartMonth: number,
): { from: IsoDate; to: IsoDate } {
  const [y, m] = parts(today);
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'this_week': {
      const start = addDays(today, -weekday(today));
      return { from: start, to: addDays(start, 6) };
    }
    case 'last_week': {
      const start = addDays(today, -weekday(today) - 7);
      return { from: start, to: addDays(start, 6) };
    }
    case 'last_30_days':
      return { from: addDays(today, -29), to: today };
    case 'this_month':
      return { from: monthStart(y, m), to: monthEnd(y, m) };
    case 'last_month': {
      const prev = parts(addDays(monthStart(y, m), -1));
      return { from: monthStart(prev[0], prev[1]), to: monthEnd(prev[0], prev[1]) };
    }
    case 'this_fiscal_year':
      return { from: fiscalYearStart(today, fyStartMonth), to: fiscalYearEnd(today, fyStartMonth) };
    case 'this_fiscal_year_to_date':
      return { from: fiscalYearStart(today, fyStartMonth), to: today };
    case 'last_fiscal_year': {
      const lastEnd = addDays(fiscalYearStart(today, fyStartMonth), -1);
      return { from: fiscalYearStart(lastEnd, fyStartMonth), to: lastEnd };
    }
    case 'this_fiscal_quarter':
    case 'last_fiscal_quarter': {
      const fys = parts(fiscalYearStart(today, fyStartMonth));
      const monthsIn = (y - fys[0]) * 12 + (m - fys[1]);
      let q = Math.floor(monthsIn / 3);
      if (preset === 'last_fiscal_quarter') q -= 1;
      const startMonthIndex = fys[1] - 1 + q * 3; // may be negative for last quarter of prior FY
      const start = new Date(Date.UTC(fys[0], startMonthIndex, 1));
      const end = new Date(Date.UTC(fys[0], startMonthIndex + 3, 0));
      return { from: fmt(start), to: fmt(end) };
    }
  }
}

/** "January 1 – March 31, 2026" style label. */
export function formatPeriod(from: IsoDate | null, to: IsoDate): string {
  const f = (d: IsoDate, withYear: boolean) => {
    const [y, m, day] = parts(d);
    const month = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', {
      month: 'long',
      timeZone: 'UTC',
    });
    return withYear ? `${month} ${day}, ${y}` : `${month} ${day}`;
  };
  if (!from) return `As of ${f(to, true)}`;
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${f(from, !sameYear)} – ${f(to, true)}`;
}

export function formatDate(d: IsoDate): string {
  const [y, m, day] = parts(d);
  return `${String(m).padStart(2, '0')}/${String(day).padStart(2, '0')}/${y}`;
}
