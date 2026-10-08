import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  decimalPlaces,
  formatDollars,
  formatMoney,
  moneyToString,
  parseMoney,
  roundMoney,
  sumMoney,
  tryParseMoney,
} from './money';

describe('money', () => {
  it('parses user input and database numerics exactly', () => {
    expect(parseMoney('1,234.56')).toBe(12_345_600n);
    expect(parseMoney('$12')).toBe(120_000n);
    expect(parseMoney('-0.01')).toBe(-100n);
    expect(parseMoney('100.4500')).toBe(1_004_500n);
    expect(tryParseMoney('abc')).toBeNull();
    expect(tryParseMoney('1.23456')).toBeNull();
    expect(tryParseMoney('')).toBeNull();
  });

  it('avoids floating point errors (0.1 + 0.2)', () => {
    expect(moneyToString(parseMoney('0.1') + parseMoney('0.2'))).toBe('0.30');
  });

  it('rounds half away from zero', () => {
    expect(moneyToString(parseMoney('1.005'))).toBe('1.01');
    expect(moneyToString(parseMoney('-1.005'))).toBe('-1.01');
    expect(moneyToString(parseMoney('1.0049'))).toBe('1.00');
    expect(roundMoney(parseMoney('2.345'), 2)).toBe(parseMoney('2.35'));
  });

  it('formats for display', () => {
    expect(formatMoney('1234567.8')).toBe('1,234,567.80');
    expect(formatMoney('-1234.5')).toBe('-1,234.50');
    expect(formatMoney('-1234.5', { parens: true })).toBe('(1,234.50)');
    expect(formatMoney('0')).toBe('0.00');
  });

  it('counts decimal places', () => {
    expect(decimalPlaces('1.234')).toBe(3);
    expect(decimalPlaces('1,000')).toBe(0);
  });

  it('round-trips any 2-decimal amount and sums associatively', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: -(10n ** 13n), max: 10n ** 13n }), { maxLength: 50 }),
        (cents) => {
          const values = cents.map((c) => c * 100n);
          for (const v of values) expect(parseMoney(moneyToString(v))).toBe(v);
          expect(sumMoney(values)).toBe(sumMoney([...values].reverse()));
        },
      ),
    );
  });
});

describe('formatDollars', () => {
  it('puts the sign before the dollar sign', () => {
    expect(formatDollars('1234.5')).toBe('$1,234.50');
    expect(formatDollars('-500')).toBe('-$500.00');
    expect(formatDollars(0n)).toBe('$0.00');
  });
});
