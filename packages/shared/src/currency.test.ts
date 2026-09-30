import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  crossRate,
  exchangeRateInputSchema,
  formatCurrency,
  homeShare,
  parseRate,
  partyCurrency,
  rateToString,
  toHome,
  tryParseRate,
} from './currency';
import { moneyToString, parseMoney } from './money';

describe('exchange rates', () => {
  it('parses exact decimals up to 10 places, never zero or negative', () => {
    expect(rateToString(parseRate('1.085'))).toBe('1.0850');
    expect(rateToString(parseRate('0.0067123456'))).toBe('0.0067123456');
    expect(rateToString(parseRate('150'))).toBe('150.0000');
    expect(tryParseRate('0')).toBeNull();
    expect(tryParseRate('-1.2')).toBeNull();
    expect(tryParseRate('1.12345678901')).toBeNull();
    expect(tryParseRate('abc')).toBeNull();
  });

  it('converts to US dollars rounded half away from zero to the cent', () => {
    // €1,000.00 at 1.0850 = $1,085.00
    expect(moneyToString(toHome(parseMoney('1000'), '1.085'))).toBe('1085.00');
    // ¥12,345 at 0.0067123456 = $82.8639... → $82.86
    expect(moneyToString(toHome(parseMoney('12345'), '0.0067123456'))).toBe('82.86');
    // £0.01 at 1.25 = $0.0125 → $0.01; £0.02 at 1.25 = $0.025 → $0.03 (half away from zero)
    expect(moneyToString(toHome(parseMoney('0.01'), '1.25'))).toBe('0.01');
    expect(moneyToString(toHome(parseMoney('0.02'), '1.25'))).toBe('0.03');
    expect(moneyToString(toHome(parseMoney('-0.02'), '1.25'))).toBe('-0.03');
  });

  it('is the same as exact arithmetic for any amount and rate', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }),
        fc.bigInt({ min: 1n, max: 10n ** 13n }),
        (amount, rate) => {
          const exact = amount * rate; // 1e-14 units
          const home = toHome(amount, rate);
          // Within half a cent of the exact value.
          const diff = home * 10n ** 10n - exact;
          const abs = diff < 0n ? -diff : diff;
          expect(abs <= 5n * 10n ** 11n).toBe(true);
          expect(home % 100n).toBe(0n);
        },
      ),
    );
  });

  it('shares a document’s US dollar value in proportion, to the cent', () => {
    // A €1,000 invoice worth $1,085.00: €333.33 of it is worth $361.66
    expect(
      moneyToString(homeShare(parseMoney('333.33'), parseMoney('1000'), parseMoney('1085'))),
    ).toBe('361.66');
    expect(homeShare(parseMoney('1000'), parseMoney('1000'), parseMoney('1085'))).toBe(
      parseMoney('1085'),
    );
    expect(homeShare(0n, parseMoney('1000'), parseMoney('1085'))).toBe(0n);
  });

  it('computes cross rates through the euro (European Central Bank rates)', () => {
    // 1 EUR = 1.0850 USD, 1 EUR = 0.8412 GBP → 1 GBP = 1.2898240609 USD
    expect(rateToString(crossRate(parseRate('1.0850'), parseRate('0.8412')))).toBe('1.2898240609');
    // 1 EUR = 162.35 JPY → 1 JPY = 0.006683092085... → 0.0066830921 USD
    expect(rateToString(crossRate(parseRate('1.0850'), parseRate('162.35')))).toBe('0.0066830921');
    // USD through itself is 1.
    expect(rateToString(crossRate(parseRate('1.0850'), parseRate('1.0850')))).toBe('1.0000');
  });

  it('formats amounts in their currency', () => {
    expect(formatCurrency('1234.5', 'EUR')).toBe('€1,234.50');
    expect(formatCurrency('1234.5', 'JPY')).toBe('¥1,235');
    expect(formatCurrency('-10', null)).toBe('-$10.00');
    expect(formatCurrency('99', 'CHF')).toBe('CHF 99.00');
    expect(formatCurrency('5', 'CAD')).toBe('CA$5.00');
  });

  it('validates rate input and party currencies', () => {
    expect(
      exchangeRateInputSchema.safeParse({ currency: 'eur', rateDate: '2026-09-30', rate: '1.08' })
        .data,
    ).toEqual({ currency: 'EUR', rateDate: '2026-09-30', rate: '1.08' });
    expect(
      exchangeRateInputSchema.safeParse({ currency: 'EUR', rateDate: '2026-09-30', rate: '0' })
        .success,
    ).toBe(false);
    expect(
      exchangeRateInputSchema.safeParse({ currency: 'XYZ', rateDate: '2026-09-30', rate: '1' })
        .success,
    ).toBe(false);
    expect(partyCurrency.parse('usd')).toBeNull();
    expect(partyCurrency.parse('')).toBeNull();
    expect(partyCurrency.parse('gbp')).toBe('GBP');
    expect(partyCurrency.safeParse('XYZ').success).toBe(false);
  });
});
