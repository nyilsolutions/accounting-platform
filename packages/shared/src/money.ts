/**
 * Exact money arithmetic. Amounts are bigint counts of 1/10,000 of a dollar (the database stores
 * NUMERIC(19,4)). Never use JS numbers for money.
 */
export type Money = bigint;

const SCALE = 4;
const FACTOR = 10n ** BigInt(SCALE);
/** Largest amount accepted from users: 999,999,999,999.99 */
export const MAX_AMOUNT: Money = 999_999_999_999_99n * 100n;

const PATTERN = /^(-)?(\d{1,15})(?:\.(\d{1,4}))?$/;

/** Parses "1,234.5", "$12", "-3.1415" or a NUMERIC string from Postgres. Throws on invalid input. */
export function parseMoney(input: string): Money {
  const clean = input.trim().replace(/[$,\s]/g, '');
  const m = PATTERN.exec(clean);
  if (!m) throw new Error(`Invalid amount: ${input}`);
  const whole = BigInt(m[2]!);
  const frac = BigInt((m[3] ?? '').padEnd(SCALE, '0'));
  const value = whole * FACTOR + frac;
  return m[1] ? -value : value;
}

export function tryParseMoney(input: string | null | undefined): Money | null {
  if (input == null || input.trim() === '') return null;
  try {
    return parseMoney(input);
  } catch {
    return null;
  }
}

/** Number of decimal places the user typed (for "cents only" validation). */
export function decimalPlaces(input: string): number {
  const dot = input
    .trim()
    .replace(/[$,\s]/g, '')
    .split('.')[1];
  return dot ? dot.length : 0;
}

/** Rounds half away from zero to `decimals` places, returning a Money value. */
export function roundMoney(value: Money, decimals = 2): Money {
  const step = 10n ** BigInt(SCALE - decimals);
  const abs = value < 0n ? -value : value;
  const rounded = ((abs + step / 2n) / step) * step;
  return value < 0n ? -rounded : rounded;
}

/** Plain decimal string with fixed decimals: "-1234.50". Used in API payloads. */
export function moneyToString(value: Money, decimals = 2): string {
  const r = roundMoney(value, decimals);
  const neg = r < 0n;
  const abs = neg ? -r : r;
  const whole = abs / FACTOR;
  const frac = (abs % FACTOR).toString().padStart(SCALE, '0').slice(0, decimals);
  return `${neg ? '-' : ''}${whole}${decimals > 0 ? `.${frac}` : ''}`;
}

/** Display format: "1,234.50", negatives as "-1,234.50" (or "(1,234.50)" for statements). */
export function formatMoney(
  value: Money | string,
  opts: { parens?: boolean; decimals?: number } = {},
): string {
  const v = typeof value === 'string' ? parseMoney(value) : value;
  const s = moneyToString(v < 0n ? -v : v, opts.decimals ?? 2);
  const [whole, frac] = s.split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = frac !== undefined ? `${grouped}.${frac}` : grouped;
  if (v >= 0n) return body;
  return opts.parens ? `(${body})` : `-${body}`;
}

export function sumMoney(values: Iterable<Money>): Money {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

export const ZERO: Money = 0n;
