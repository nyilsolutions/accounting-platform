import { addDays, addMonths, fiscalYearStart, monthStartOf } from '@acct/shared';

export interface Period {
  from: string;
  to: string;
  label: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthName(d: string): string {
  return MONTHS[Number(d.slice(5, 7)) - 1]!;
}

/** "Jan 2026", "Jan – Mar 2026", "Nov 2025 – Jan 2026", "Jan 5 – 20, 2026" (partial months). */
export function periodLabel(from: string, to: string): string {
  const fy = from.slice(0, 4);
  const ty = to.slice(0, 4);
  const wholeStart = from.endsWith('-01');
  const wholeEnd = addDays(to, 1).endsWith('-01');
  if (wholeStart && wholeEnd) {
    if (from.slice(0, 7) === to.slice(0, 7)) return `${monthName(from)} ${fy}`;
    return fy === ty
      ? `${monthName(from)} – ${monthName(to)} ${ty}`
      : `${monthName(from)} ${fy} – ${monthName(to)} ${ty}`;
  }
  const day = (d: string) => String(Number(d.slice(8, 10)));
  if (from === to) return `${monthName(from)} ${day(from)}, ${fy}`;
  if (from.slice(0, 7) === to.slice(0, 7))
    return `${monthName(from)} ${day(from)} – ${day(to)}, ${ty}`;
  return fy === ty
    ? `${monthName(from)} ${day(from)} – ${monthName(to)} ${day(to)}, ${ty}`
    : `${monthName(from)} ${day(from)}, ${fy} – ${monthName(to)} ${day(to)}, ${ty}`;
}

/**
 * Splits [from, to] into calendar months, fiscal quarters or fiscal years (the first and last
 * periods are cut to the range).
 */
export function splitPeriods(
  from: string,
  to: string,
  mode: 'months' | 'quarters' | 'years',
  fyStartMonth: number,
): Period[] {
  const step = mode === 'months' ? 1 : mode === 'quarters' ? 3 : 12;
  // Periods are aligned to the fiscal year (months are aligned to themselves).
  let start = mode === 'months' ? monthStartOf(from) : fiscalYearStart(from, fyStartMonth);
  while (addMonths(start, step) <= from) start = addMonths(start, step);
  const out: Period[] = [];
  while (start <= to) {
    const end = addDays(addMonths(start, step), -1);
    const f = start < from ? from : start;
    const t = end > to ? to : end;
    out.push({ from: f, to: t, label: periodLabel(f, t) });
    start = addMonths(start, step);
  }
  return out;
}

/** The comparison period: the same dates a year earlier, or the equally long period before. */
export function comparisonPeriod(
  from: string,
  to: string,
  compare: 'prior_year' | 'prior_period',
): { from: string; to: string } {
  if (compare === 'prior_year') return { from: addMonths(from, -12), to: addMonths(to, -12) };
  const days = Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
  const prevTo = addDays(from, -1);
  // Whole months map to whole months (Mar → Feb), otherwise the same number of days.
  if (from.endsWith('-01') && addDays(to, 1).endsWith('-01')) {
    const months =
      (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
      Number(to.slice(5, 7)) -
      Number(from.slice(5, 7)) +
      1;
    return { from: addMonths(from, -months), to: prevTo };
  }
  return { from: addDays(prevTo, -days), to: prevTo };
}
