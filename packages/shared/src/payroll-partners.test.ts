import { describe, expect, it } from 'vitest';
import { eftpsEnrollSchema, standInDepositSchema } from './payroll-partners';

describe('eftpsEnrollSchema', () => {
  const base = {
    routingNumber: '021000021',
    accountNumber: '000123456789',
    accountType: 'checking',
    authorizedName: 'Olive Owner',
    authorizedTitle: 'Owner',
    authorize: true,
  };

  it('needs a valid routing number, an account number and the authorization', () => {
    expect(eftpsEnrollSchema.safeParse(base).success).toBe(true);
    const bad = eftpsEnrollSchema.safeParse({
      ...base,
      routingNumber: '021000022',
      accountNumber: '12',
      authorize: false,
    });
    expect(bad.error!.issues.map((i) => i.path[0]).sort()).toEqual([
      'accountNumber',
      'authorize',
      'routingNumber',
    ]);
  });
});

describe('standInDepositSchema', () => {
  it('returns an entry with an R code', () => {
    const ok = standInDepositSchema.parse({
      action: 'return',
      entryId: crypto.randomUUID(),
      code: 'r03',
      reason: 'No account',
    });
    expect(ok).toMatchObject({ code: 'R03' });
    expect(
      standInDepositSchema.safeParse({
        action: 'return',
        entryId: crypto.randomUUID(),
        code: 'X1',
        reason: 'No account',
      }).success,
    ).toBe(false);
  });
});
