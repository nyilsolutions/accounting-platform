import { describe, expect, it } from 'vitest';
import {
  CANONICAL_SCHEMAS,
  CSV_KIND_SPECS,
  guessColumnMapping,
  normalizeHeader,
} from './migration';

describe('CSV column mapping', () => {
  it('matches QuickBooks export headers regardless of case and punctuation', () => {
    expect(normalizeHeader(' Billing Address Line 1 ')).toBe('billingaddressline1');
    expect(
      guessColumnMapping('gl_detail', [
        'Trans #',
        'Type',
        'Date',
        'Num',
        'Name',
        'Memo',
        'Account',
        'Debit',
        'Credit',
      ]),
    ).toEqual({
      txnNo: 0,
      type: 1,
      date: 2,
      number: 3,
      name: 4,
      memo: 5,
      account: 6,
      debit: 7,
      credit: 8,
    });
  });

  it('never maps two fields to one column', () => {
    const m = guessColumnMapping('customers', ['Name', 'Company', 'Notes']);
    expect(new Set(Object.values(m)).size).toBe(Object.values(m).length);
  });

  it('marks what each kind needs', () => {
    for (const spec of Object.values(CSV_KIND_SPECS))
      expect(spec.fields.some((f) => f.required)).toBe(true);
    expect(CSV_KIND_SPECS.opening_balances.needsDate).toBe('opening');
  });
});

describe('canonical records', () => {
  it('accept exact decimals and ISO dates only', () => {
    const ok = CANONICAL_SCHEMAS.transfer.safeParse({
      txnDate: '2025-01-31',
      fromAccount: 'a',
      toAccount: 'b',
      amount: '12.3456789',
    });
    expect(ok.success).toBe(true);
    expect(
      CANONICAL_SCHEMAS.transfer.safeParse({
        txnDate: '01/31/2025',
        fromAccount: 'a',
        toAccount: 'b',
        amount: '1',
      }).success,
    ).toBe(false);
    expect(
      CANONICAL_SCHEMAS.transfer.safeParse({
        txnDate: '2025-01-31',
        fromAccount: 'a',
        toAccount: 'b',
        amount: 1.5,
      }).success,
    ).toBe(false);
  });
});
