import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { moneyToString, parseMoney } from './money';
import {
  dueDateFromTerms,
  lineAmount,
  paymentInputSchema,
  resolveLineAmount,
  salesDocumentInputSchema,
} from './sales';

const ACCT = '00000000-0000-4000-8000-000000000001';
const CUST = '00000000-0000-4000-8000-000000000002';

describe('line amounts', () => {
  it('multiplies quantity by rate and rounds half away from zero to cents', () => {
    expect(moneyToString(lineAmount('3', '19.99'))).toBe('59.97');
    expect(moneyToString(lineAmount('1.5', '0.333'))).toBe('0.50');
    expect(moneyToString(lineAmount('0.3333', '3'))).toBe('1.00');
    expect(moneyToString(lineAmount('2', '-12.505'))).toBe('-25.01');
    expect(moneyToString(lineAmount('0.001', '5'))).toBe('0.01');
  });

  it('matches exact rational arithmetic for any 4-decimal inputs', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 9n }),
        fc.bigInt({ min: -(10n ** 9n), max: 10n ** 9n }),
        (q4, r4) => {
          const q = moneyToString(q4, 4);
          const r = moneyToString(r4, 4);
          // Exact product in 1e-8 units, rounded to cents by hand.
          const p = q4 * r4;
          const abs = p < 0n ? -p : p;
          const cents = (abs * 2n + 1_000_000n) / 2_000_000n;
          expect(lineAmount(q, r)).toBe((p < 0n ? -cents : cents) * 100n);
        },
      ),
    );
  });

  it('uses quantity × rate when both are present, otherwise the amount', () => {
    expect(resolveLineAmount({ quantity: '2', rate: '10', amount: '999' })).toBe(parseMoney('20'));
    expect(resolveLineAmount({ amount: '-5' })).toBe(parseMoney('-5'));
  });
});

describe('salesDocumentInputSchema', () => {
  it('accepts discounts but requires a positive total', () => {
    const ok = salesDocumentInputSchema.safeParse({
      customerId: CUST,
      txnDate: '2026-01-01',
      lines: [
        { accountId: ACCT, quantity: '2', rate: '50' },
        { accountId: ACCT, amount: '-10' },
      ],
    });
    expect(ok.success).toBe(true);
    const zero = salesDocumentInputSchema.safeParse({
      txnDate: '2026-01-01',
      lines: [{ accountId: ACCT, amount: '0' }],
    });
    expect(zero.success).toBe(false);
  });

  it('requires an item or account, and a due date on or after the date', () => {
    const r = salesDocumentInputSchema.safeParse({
      txnDate: '2026-02-01',
      dueDate: '2026-01-01',
      lines: [{ amount: '5' }],
    });
    expect(r.success).toBe(false);
    const paths = r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['lines.0.itemId', 'dueDate']));
  });
});

describe('paymentInputSchema', () => {
  it('rejects duplicate applications and empty payments', () => {
    const r = paymentInputSchema.safeParse({
      customerId: CUST,
      txnDate: '2026-01-01',
      amount: '10',
      applications: [
        { targetId: ACCT, amount: '5' },
        { targetId: ACCT, amount: '5' },
      ],
    });
    expect(r.success).toBe(false);
    expect(
      paymentInputSchema.safeParse({ customerId: CUST, txnDate: '2026-01-01', amount: '0' })
        .success,
    ).toBe(false);
  });
});

describe('dueDateFromTerms', () => {
  it('adds net days across month ends', () => {
    expect(dueDateFromTerms('2026-01-31', 30)).toBe('2026-03-02');
    expect(dueDateFromTerms('2026-01-31', 0)).toBe('2026-01-31');
  });
});
