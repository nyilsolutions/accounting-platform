import { describe, expect, it } from 'vitest';
import {
  acceptFeedSchema,
  bankRuleInputSchema,
  csvMappingSchema,
  firstMatchingRule,
  isRegisterAccountType,
  isTransferAccountType,
  mapFeedAccountsSchema,
  ruleMatches,
  transferInputSchema,
  type BankRuleValues,
} from './banking';

const id = () => crypto.randomUUID();
const bank = id();
const card = id();

function rule(overrides: Partial<BankRuleValues>): BankRuleValues {
  return bankRuleInputSchema.parse({
    name: 'Rule',
    conditions: [{ field: 'description', operator: 'contains', value: 'shell' }],
    action: 'categorize',
    accountId: id(),
    ...overrides,
  });
}

const fuel = { accountId: bank, amount: '-42.17', description: 'SHELL OIL 5741', payee: 'Shell' };

describe('account types', () => {
  it('limits registers and transfers to balance sheet accounts', () => {
    expect(isRegisterAccountType('bank')).toBe(true);
    expect(isRegisterAccountType('credit_card')).toBe(true);
    expect(isRegisterAccountType('long_term_liability')).toBe(true);
    expect(isRegisterAccountType('accounts_receivable')).toBe(false);
    expect(isRegisterAccountType('expense')).toBe(false);
    expect(isTransferAccountType('equity')).toBe(true);
    expect(isTransferAccountType('accounts_payable')).toBe(false);
    expect(isTransferAccountType('income')).toBe(false);
  });
});

describe('transferInputSchema', () => {
  it('needs two different accounts and a positive amount', () => {
    const base = { fromAccountId: bank, toAccountId: card, txnDate: '2026-05-01', amount: '100' };
    expect(transferInputSchema.safeParse(base).success).toBe(true);
    const same = transferInputSchema.safeParse({ ...base, toAccountId: bank });
    expect(same.error?.issues[0]?.path).toEqual(['toAccountId']);
    expect(transferInputSchema.safeParse({ ...base, amount: '0' }).success).toBe(false);
    expect(transferInputSchema.safeParse({ ...base, amount: '-5' }).success).toBe(false);
  });
});

describe('bank rules', () => {
  it('requires a category unless the rule excludes', () => {
    const r = bankRuleInputSchema.safeParse({
      name: 'x',
      conditions: [{ field: 'amount', operator: 'equals', value: '5' }],
      action: 'categorize',
    });
    expect(r.error?.issues[0]?.path).toEqual(['accountId']);
    expect(
      bankRuleInputSchema.safeParse({
        name: 'x',
        conditions: [{ field: 'amount', operator: 'equals', value: '5' }],
        action: 'exclude',
      }).success,
    ).toBe(true);
  });

  it('matches text case-insensitively', () => {
    expect(ruleMatches(rule({}), fuel)).toBe(true);
    expect(
      ruleMatches(
        rule({ conditions: [{ field: 'description', operator: 'starts_with', value: 'oil' }] }),
        fuel,
      ),
    ).toBe(false);
    expect(
      ruleMatches(
        rule({ conditions: [{ field: 'payee', operator: 'equals', value: 'SHELL' }] }),
        fuel,
      ),
    ).toBe(true);
    expect(
      ruleMatches(
        rule({ conditions: [{ field: 'description', operator: 'not_contains', value: 'shell' }] }),
        fuel,
      ),
    ).toBe(false);
  });

  it('compares amounts without their sign', () => {
    const r = (operator: 'equals' | 'greater_than' | 'less_than', value: string) =>
      ruleMatches(rule({ conditions: [{ field: 'amount', operator, value }] }), fuel);
    expect(r('equals', '42.17')).toBe(true);
    expect(r('greater_than', '40')).toBe(true);
    expect(r('less_than', '40')).toBe(false);
  });

  it('respects direction, accounts, all/any and inactive rules', () => {
    expect(ruleMatches(rule({ direction: 'in' }), fuel)).toBe(false);
    expect(ruleMatches(rule({ direction: 'out' }), fuel)).toBe(true);
    expect(ruleMatches(rule({ accountIds: [card] }), fuel)).toBe(false);
    expect(ruleMatches(rule({ accountIds: [card, bank] }), fuel)).toBe(true);
    const conditions = [
      { field: 'description' as const, operator: 'contains' as const, value: 'shell' },
      { field: 'amount' as const, operator: 'greater_than' as const, value: '100' },
    ];
    expect(ruleMatches(rule({ conditions, matchAll: true }), fuel)).toBe(false);
    expect(ruleMatches(rule({ conditions, matchAll: false }), fuel)).toBe(true);
    expect(ruleMatches(rule({ isActive: false }), fuel)).toBe(false);
  });

  it('picks the first rule by priority, then name', () => {
    const rules = [
      rule({ name: 'B', priority: 10 }),
      rule({ name: 'A', priority: 10 }),
      rule({ name: 'Z', priority: 1, direction: 'in' }),
      rule({ name: 'Last', priority: 50 }),
    ];
    expect(firstMatchingRule(rules, fuel)?.name).toBe('A');
    expect(firstMatchingRule(rules, { ...fuel, description: 'COFFEE' })).toBeNull();
  });
});

describe('feed and import schemas', () => {
  it('accepts add, transfer and match actions', () => {
    expect(
      acceptFeedSchema.safeParse({ action: 'add', lines: [{ accountId: id(), amount: '42.17' }] })
        .success,
    ).toBe(true);
    expect(acceptFeedSchema.safeParse({ action: 'transfer', accountId: id() }).success).toBe(true);
    expect(acceptFeedSchema.safeParse({ action: 'match', transactionId: 'x' }).success).toBe(false);
  });

  it('needs the amount columns for the chosen CSV mode', () => {
    const base = { hasHeader: true, dateColumn: 0, descriptionColumn: 1, dateFormat: 'MDY' };
    expect(csvMappingSchema.safeParse({ ...base, amountMode: 'signed' }).success).toBe(false);
    expect(
      csvMappingSchema.safeParse({ ...base, amountMode: 'split', moneyOutColumn: 2 }).success,
    ).toBe(false);
    expect(
      csvMappingSchema.safeParse({ ...base, amountMode: 'signed', amountColumn: 2 }).success,
    ).toBe(true);
  });

  it('connects each chart account to one feed account at most', () => {
    const accountId = id();
    const r = mapFeedAccountsSchema.safeParse({
      accounts: [
        { id: id(), accountId },
        { id: id(), accountId },
        { id: id(), accountId: null },
      ],
    });
    expect(r.error?.issues[0]?.path).toEqual(['accounts', 1, 'accountId']);
  });
});
