import type { Money } from '@acct/shared';

/**
 * Exact fractions for tax arithmetic. Withholding methods multiply, annualize and divide by pay
 * periods; doing that in exact fractions and rounding once (or where the publication says to
 * round) avoids drift. Money is bigint in 1/10,000 units.
 */
export interface Q {
  readonly n: bigint;
  readonly d: bigint;
}

const MONEY_SCALE = 10_000n;

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a || 1n;
}

export function q(n: bigint, d = 1n): Q {
  if (d === 0n) throw new Error('Division by zero');
  if (d < 0n) [n, d] = [-n, -d];
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

export const Q0 = q(0n);

export function fromMoney(m: Money): Q {
  return q(m, MONEY_SCALE);
}

/** A plain decimal string ("6.2", "184500.00", "-1.5"). */
export function dec(s: string): Q {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`Not a decimal: ${s}`);
  const frac = m[3] ?? '';
  const n = BigInt(m[2]! + frac) * (m[1] ? -1n : 1n);
  return q(n, 10n ** BigInt(frac.length));
}

/** A percentage string as a fraction ("4.95" → 0.0495). */
export function pct(s: string): Q {
  return div(dec(s), q(100n));
}

export function add(a: Q, b: Q): Q {
  return q(a.n * b.d + b.n * a.d, a.d * b.d);
}
export function sub(a: Q, b: Q): Q {
  return q(a.n * b.d - b.n * a.d, a.d * b.d);
}
export function mul(a: Q, b: Q): Q {
  return q(a.n * b.n, a.d * b.d);
}
export function div(a: Q, b: Q): Q {
  return q(a.n * b.d, a.d * b.n);
}
export function cmp(a: Q, b: Q): number {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
}
export function max(a: Q, b: Q): Q {
  return cmp(a, b) >= 0 ? a : b;
}
export function min(a: Q, b: Q): Q {
  return cmp(a, b) <= 0 ? a : b;
}

/** Rounds half away from zero to whole cents and returns Money. */
export function toCents(v: Q): Money {
  const neg = v.n < 0n;
  const n = neg ? -v.n : v.n;
  const cents = (2n * n * 100n + v.d) / (2n * v.d);
  return (neg ? -cents : cents) * (MONEY_SCALE / 100n);
}

/** `toCents` as a fraction, for methods that round at each step. */
export function roundCents(v: Q): Q {
  return fromMoney(toCents(v));
}

/** Rounds half away from zero to whole dollars and returns Money. */
export function toDollars(v: Q): Money {
  const neg = v.n < 0n;
  const n = neg ? -v.n : v.n;
  const dollars = (2n * n + v.d) / (2n * v.d);
  return (neg ? -dollars : dollars) * MONEY_SCALE;
}
