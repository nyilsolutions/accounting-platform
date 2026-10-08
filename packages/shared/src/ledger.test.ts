import { describe, expect, it } from 'vitest';
import { ACCOUNT_TYPE_INFO, ACCOUNT_TYPES, journalEntryInputSchema } from './ledger';

const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';

function issues(input: unknown): string[] {
  const r = journalEntryInputSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('journalEntryInputSchema', () => {
  it('accepts a balanced entry and normalizes amounts', () => {
    const parsed = journalEntryInputSchema.parse({
      txnDate: '2026-01-31',
      lines: [
        { accountId: A, debit: '$1,000.00' },
        { accountId: B, credit: '1000' },
      ],
    });
    expect(parsed.lines[0]!.debit).toBe('1000.00');
    expect(parsed.isAdjusting).toBe(false);
  });

  it('rejects unbalanced, one-sided, two-sided and over-precise lines', () => {
    expect(
      issues({
        txnDate: '2026-01-31',
        lines: [
          { accountId: A, debit: '1' },
          { accountId: B, credit: '2' },
        ],
      }),
    ).toContain('lines: Debits and credits must be equal');
    expect(issues({ txnDate: '2026-01-31', lines: [{ accountId: A, debit: '1' }] })).toContain(
      'lines: A journal entry needs at least two lines',
    );
    expect(
      issues({
        txnDate: '2026-01-31',
        lines: [{ accountId: A, debit: '1', credit: '1' }, { accountId: B }],
      }),
    ).toEqual(
      expect.arrayContaining([
        'lines.0.credit: A line can have a debit or a credit, not both',
        'lines.1.debit: Enter a debit or credit amount',
      ]),
    );
    expect(
      issues({
        txnDate: '2026-01-31',
        lines: [
          { accountId: A, debit: '1.001' },
          { accountId: B, credit: '1.001' },
        ],
      }),
    ).toContain('lines.0.debit: Amounts can have at most 2 decimal places');
    expect(issues({ txnDate: '2026-02-30', lines: [] })).toContain('txnDate: Enter a valid date');
  });
});

describe('account types', () => {
  it('assigns every type a statement and normal balance consistent with its category', () => {
    for (const t of ACCOUNT_TYPES) {
      const info = ACCOUNT_TYPE_INFO[t];
      const debitNormal = info.category === 'asset' || info.category === 'expense';
      expect(info.normalBalance).toBe(debitNormal ? 'debit' : 'credit');
      expect(info.statement).toBe(
        ['income', 'expense'].includes(info.category) ? 'profit_and_loss' : 'balance_sheet',
      );
    }
  });
});
