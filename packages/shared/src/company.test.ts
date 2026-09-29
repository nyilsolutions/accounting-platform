import { describe, expect, it } from 'vitest';
import { companyInputSchema, maskEin } from './company';

describe('companyInputSchema', () => {
  it('normalizes EIN and blanks', () => {
    const parsed = companyInputSchema.parse({
      legalName: ' Acme LLC ',
      ein: '123456789',
      dbaName: '',
    });
    expect(parsed.legalName).toBe('Acme LLC');
    expect(parsed.ein).toBe('12-3456789');
    expect(parsed.dbaName).toBeNull();
    expect(parsed.fiscalYearStartMonth).toBe(1);
    expect(parsed.accountingBasis).toBe('accrual');
  });

  it('rejects malformed EIN and ZIP', () => {
    expect(companyInputSchema.safeParse({ legalName: 'A', ein: '12-345' }).success).toBe(false);
    expect(companyInputSchema.safeParse({ legalName: 'A', postalCode: '1234' }).success).toBe(
      false,
    );
  });

  it('masks EIN', () => {
    expect(maskEin('6789')).toBe('**-***6789');
    expect(maskEin(null)).toBeNull();
  });
});

describe('companyUpdateSchema', () => {
  it('does not apply create-time defaults to a partial update', async () => {
    const { companyUpdateSchema } = await import('./company');
    expect(companyUpdateSchema.parse({ city: 'Austin' })).toEqual({ city: 'Austin' });
    expect(companyUpdateSchema.parse({})).toEqual({});
  });
});
