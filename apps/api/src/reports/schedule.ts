import {
  addDays,
  monthEndOf,
  presetRange,
  weekday,
  type MemorizedParams,
  type ReportQuery,
  type ScheduleFrequency,
} from '@acct/shared';

export interface ScheduleRule {
  frequency: ScheduleFrequency;
  day: number;
  hour: number;
  timezone: string;
}

interface Parts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function zoned(date: Date, timeZone: string): Parts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return {
    y: get('year'),
    m: get('month'),
    d: get('day'),
    h: get('hour'),
    mi: get('minute'),
    s: get('second'),
  };
}

/** The calendar date in a time zone ("today" where the report's reader is). */
export function localDate(now: Date, timeZone: string): string {
  const p = zoned(now, timeZone);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

function offsetMs(date: Date, timeZone: string): number {
  const p = zoned(date, timeZone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** A local wall-clock hour on a date in a time zone, as an instant. */
export function localHourToUtc(date: string, hour: number, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, hour);
  let utc = guess - offsetMs(new Date(guess), timeZone);
  // Around a daylight-saving change the offset at the answer can differ from the guess's.
  const second = offsetMs(new Date(utc), timeZone);
  if (guess - second !== utc) utc = guess - second;
  return new Date(utc);
}

function matches(rule: ScheduleRule, date: string): boolean {
  if (rule.frequency === 'daily') return true;
  if (rule.frequency === 'weekly') return weekday(date) === rule.day;
  return rule.day === 0 ? date === monthEndOf(date) : Number(date.slice(8, 10)) === rule.day;
}

/** The first time after `after` the schedule is due. */
export function nextRunAt(rule: ScheduleRule, after: Date): Date {
  const today = localDate(after, rule.timezone);
  for (let i = 0; i < 400; i++) {
    const date = addDays(today, i);
    if (!matches(rule, date)) continue;
    const at = localHourToUtc(date, rule.hour, rule.timezone);
    if (at > after) return at;
  }
  throw new Error('No next run within a year');
}

/** A memorized report's query for "today": relative dates become real ones. */
export function resolveQuery(
  params: MemorizedParams,
  today: string,
  fyStartMonth: number,
): ReportQuery {
  const { datePreset, from, to, definition: _definition, ...filters } = params;
  const range =
    datePreset === 'custom'
      ? { from: from ?? to!, to: to! }
      : presetRange(datePreset, today, fyStartMonth);
  return { ...filters, from: range.from, to: range.to };
}
