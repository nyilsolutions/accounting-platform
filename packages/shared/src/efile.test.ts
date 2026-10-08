import { describe, expect, it } from 'vitest';
import { efileTransmitSchema, standInAckSchema } from './efile';

const signer = { name: 'Olive Owner', title: 'Owner', phone: '(555) 010-0100' };

describe('efileTransmitSchema', () => {
  it('needs a quarter for Form 941 only, and the attestation', () => {
    expect(
      efileTransmitSchema.safeParse({ form: 'form_941', taxYear: 2026, signer, attest: true })
        .success,
    ).toBe(false);
    expect(
      efileTransmitSchema.safeParse({
        form: 'form_941',
        taxYear: 2026,
        quarter: 1,
        signer,
        attest: true,
      }).success,
    ).toBe(true);
    expect(
      efileTransmitSchema.safeParse({
        form: 'form_940',
        taxYear: 2026,
        quarter: 1,
        signer,
        attest: true,
      }).success,
    ).toBe(false);
    expect(
      efileTransmitSchema.safeParse({ form: 'form_940', taxYear: 2026, signer, attest: false })
        .success,
    ).toBe(false);
  });

  it('checks the signer', () => {
    const bad = efileTransmitSchema.safeParse({
      form: 'form_1099',
      taxYear: 2026,
      signer: { name: '', title: 'Owner', phone: 'call me', email: 'nope' },
      attest: true,
    });
    expect(bad.success).toBe(false);
    expect(bad.error!.issues.map((i) => i.path.join('.')).sort()).toEqual([
      'signer.email',
      'signer.name',
      'signer.phone',
    ]);
    const ok = efileTransmitSchema.parse({
      form: 'form_1099',
      taxYear: 2026,
      signer: { ...signer, email: '' },
      attest: true,
    });
    expect(ok.signer.email).toBeNull();
  });
});

describe('standInAckSchema', () => {
  it('needs at least one error to reject', () => {
    expect(standInAckSchema.safeParse({ action: 'accept' }).success).toBe(true);
    expect(standInAckSchema.safeParse({ action: 'reject', errors: [] }).success).toBe(false);
    expect(
      standInAckSchema.safeParse({
        action: 'reject',
        errors: [{ code: 'SI-0001', message: 'EIN does not match' }],
      }).success,
    ).toBe(true);
  });
});
