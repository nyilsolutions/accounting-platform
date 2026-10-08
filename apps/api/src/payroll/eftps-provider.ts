/**
 * How federal payroll taxes are paid. Today the employer pays in EFTPS themselves and records
 * the payment here with its EFT acknowledgement number: `ManualEftpsProvider` returns what to
 * enter. A payroll partner that pays through EFTPS (Phase 11) implements `submit` and returns its
 * own reference instead. The payments service only talks to this interface.
 */
export interface EftpsPayment {
  /** The company's EIN (decrypted only to build instructions; never logged or stored here). */
  einLast4: string | null;
  form: '941' | '940';
  /** The tax period the deposit applies to. */
  taxYear: number;
  quarter: 1 | 2 | 3 | 4 | null;
  amount: string;
  settlementDate: string;
}

export type EftpsResult =
  { kind: 'manual'; instructions: string[] } | { kind: 'submitted'; reference: string };

export interface EftpsProvider {
  readonly name: string;
  submit(payment: EftpsPayment): Promise<EftpsResult>;
}

export const EFTPS_PROVIDER = Symbol('EFTPS_PROVIDER');

export class ManualEftpsProvider implements EftpsProvider {
  readonly name = 'manual';

  submit(p: EftpsPayment): Promise<EftpsResult> {
    const period =
      p.form === '941' ? `quarter ${p.quarter} of ${p.taxYear}` : `tax year ${p.taxYear}`;
    return Promise.resolve({
      kind: 'manual',
      instructions: [
        `In EFTPS, sign in with the company's EIN${p.einLast4 ? ` (ending ${p.einLast4})` : ''}.`,
        `Make a business tax payment: Form ${p.form}, ${p.form === '941' ? 'Federal Tax Deposit' : 'Federal Unemployment (FUTA) deposit'}, ${period}.`,
        `Amount $${p.amount}, settlement date ${p.settlementDate}.`,
        "Enter the EFT acknowledgement number EFTPS gives you as this payment's reference.",
      ],
    });
  }
}
