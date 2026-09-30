import { buildAchFile, type AchFileInput } from './nacha';

/**
 * How direct deposits leave the company: a NACHA file the employer uploads to their bank (ODFI)
 * today, or a payroll-payments partner's API later. The pay run and prenote code only talks to
 * this interface.
 */
export interface PaymentRail {
  readonly name: string;
  submit(batch: AchFileInput): Promise<PaymentRailResult>;
}

export type PaymentRailResult =
  /** A file for the employer to upload to their bank. Never stored or logged. */
  | { kind: 'file'; filename: string; contentType: string; content: string }
  /** Accepted by a partner, which returns its own reference. */
  | { kind: 'submitted'; reference: string };

export const PAYMENT_RAIL = Symbol('PAYMENT_RAIL');

/** Builds a NACHA file for upload to the employer's bank. */
export class NachaFileRail implements PaymentRail {
  readonly name = 'nacha-file';

  submit(batch: AchFileInput): Promise<PaymentRailResult> {
    const content = buildAchFile(batch);
    const kind = batch.batches[0]?.entryDescription.toLowerCase().replace(/\s+/g, '-') ?? 'ach';
    const date = batch.batches[0]?.effectiveDate ?? batch.createdAt.toISOString().slice(0, 10);
    return Promise.resolve({
      kind: 'file',
      filename: `${kind}-${date}.ach`,
      contentType: 'text/plain; charset=us-ascii',
      content,
    });
  }
}
