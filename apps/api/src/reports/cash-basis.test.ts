import fc from 'fast-check';
import { parseMoney } from '@acct/shared';
import { describe, expect, it } from 'vitest';
import { allocate } from './cash-basis';

const $ = parseMoney;
const cents = fc.integer({ min: -50_000_00, max: 50_000_00 }).map((c) => BigInt(c) * 100n);

describe('allocate', () => {
  it('splits in proportion and rounds to the cent', () => {
    // Invoice lines 900 + 100 (credits shown negative), 400 of 1000 paid.
    expect(allocate([$('-900'), $('-100')], $('-1000'), $('-400'))).toEqual([$('-360'), $('-40')]);
    // Thirds: the remainder goes to the largest line.
    expect(allocate([$('-100'), $('-100'), $('-100')], $('-300'), $('-100'))).toEqual([
      $('-33.34'),
      $('-33.33'),
      $('-33.33'),
    ]);
    // A discount line (opposite sign) is scaled too.
    expect(allocate([$('-110'), $('10')], $('-100'), $('-50'))).toEqual([$('-55'), $('5')]);
  });

  it('returns the lines exactly when the whole amount is allocated', () => {
    expect(allocate([$('-33.33'), $('-66.67')], $('-100'), $('-100'))).toEqual([
      $('-33.33'),
      $('-66.67'),
    ]);
  });

  it('always sums to the portion, and cumulative allocation ends at the original lines', () => {
    fc.assert(
      fc.property(
        fc.array(cents, { minLength: 1, maxLength: 6 }),
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 5 }),
        (values, weights) => {
          const total = values.reduce((s, v) => s + v, 0n);
          fc.pre(total !== 0n);
          // Split the total into cumulative portions by the weights.
          const wsum = weights.reduce((s, w) => s + w, 0);
          let acc = 0n;
          let prev = values.map(() => 0n);
          let recognised = values.map(() => 0n);
          weights.forEach((w, i) => {
            const portion =
              i === weights.length - 1
                ? total
                : acc + ((total * BigInt(w)) / BigInt(wsum) / 100n) * 100n;
            acc = portion;
            const cur = allocate(values, total, portion);
            expect(cur.reduce((s, v) => s + v, 0n)).toBe(portion);
            expect(cur.every((v) => v % 100n === 0n)).toBe(true);
            recognised = recognised.map((r, k) => r + cur[k]! - prev[k]!);
            prev = cur;
          });
          expect(recognised).toEqual(values);
        },
      ),
    );
  });
});
