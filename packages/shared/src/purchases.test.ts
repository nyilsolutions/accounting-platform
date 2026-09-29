import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseMoney } from './money';
import { amountInWords } from './money-words';
import {
  billPaymentInputSchema,
  payBillsInputSchema,
  purchaseDocumentInputSchema,
  purchaseOrderInputSchema,
  vendor1099MappingSchema,
} from './purchases';

const id = () => crypto.randomUUID();

describe('amountInWords', () => {
  it.each([
    ['0', 'Zero and 00/100'],
    ['0.05', 'Zero and 05/100'],
    ['7', 'Seven and 00/100'],
    ['19.99', 'Nineteen and 99/100'],
    ['40', 'Forty and 00/100'],
    ['1234.56', 'One thousand two hundred thirty-four and 56/100'],
    ['100000', 'One hundred thousand and 00/100'],
    ['2000001.10', 'Two million one and 10/100'],
    [
      '999999999.99',
      'Nine hundred ninety-nine million nine hundred ninety-nine thousand nine hundred ninety-nine and 99/100',
    ],
  ])('%s → %s', (amount, words) => {
    expect(amountInWords(parseMoney(amount))).toBe(words);
  });

  it('never produces empty groups or double spaces', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 16n }), (cents) => {
        const w = amountInWords(cents * 100n);
        expect(w).not.toMatch(/ {2}|^ | $|undefined/);
        expect(w).toMatch(/ and \d{2}\/100$/);
      }),
    );
  });

  it('rejects negative amounts', () => {
    expect(() => amountInWords(-1n)).toThrow();
  });
});

describe('purchase schemas', () => {
  const base = { txnDate: '2026-05-01', lines: [{ accountId: id(), amount: '50' }] };

  it('accepts a bill with category lines and computes nothing from floats', () => {
    const r = purchaseDocumentInputSchema.safeParse({ ...base, vendorId: id(), number: 'INV-77' });
    expect(r.success).toBe(true);
  });

  it('needs a category or product on each line, and a positive total', () => {
    const r = purchaseDocumentInputSchema.safeParse({
      txnDate: '2026-05-01',
      lines: [{ amount: '5' }],
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path.join('.'))).toContain('lines.0.accountId');
    const neg = purchaseDocumentInputSchema.safeParse({
      ...base,
      lines: [{ accountId: id(), amount: '-5' }],
    });
    expect(neg.error!.issues[0]!.message).toMatch(/greater than zero/);
  });

  it('due date cannot be before the bill date', () => {
    const r = purchaseDocumentInputSchema.safeParse({ ...base, dueDate: '2026-04-01' });
    expect(r.error!.issues[0]!.path).toEqual(['dueDate']);
  });

  it('bill payments need applications, without duplicates or zero amounts', () => {
    const target = id();
    const p = { vendorId: id(), txnDate: '2026-05-01', paymentAccountId: id() };
    expect(billPaymentInputSchema.safeParse({ ...p, applications: [] }).success).toBe(false);
    const dup = billPaymentInputSchema.safeParse({
      ...p,
      applications: [
        { targetId: target, amount: '1' },
        { targetId: target, amount: '0' },
      ],
    });
    expect(dup.error!.issues.map((i) => i.message)).toEqual([
      'Listed twice',
      'Enter an amount greater than zero',
    ]);
  });

  it('pay bills accepts an optional numeric first check number', () => {
    const p = {
      txnDate: '2026-05-01',
      paymentAccountId: id(),
      applications: [{ targetId: id(), amount: '5' }],
    };
    expect(payBillsInputSchema.safeParse({ ...p, firstCheckNumber: '1001' }).success).toBe(true);
    expect(payBillsInputSchema.safeParse({ ...p, firstCheckNumber: '' }).success).toBe(true);
    expect(payBillsInputSchema.safeParse({ ...p, firstCheckNumber: 'A1' }).success).toBe(false);
  });

  it('purchase orders and 1099 mappings', () => {
    expect(purchaseOrderInputSchema.safeParse({ ...base, vendorId: id() }).success).toBe(true);
    const account = id();
    const dup = vendor1099MappingSchema.safeParse({
      mappings: [
        { accountId: account, box: 'nec_1' },
        { accountId: account, box: 'misc_1' },
      ],
    });
    expect(dup.success).toBe(false);
    expect(
      vendor1099MappingSchema.safeParse({ mappings: [{ accountId: account, box: 'w2' }] }).success,
    ).toBe(false);
  });
});
