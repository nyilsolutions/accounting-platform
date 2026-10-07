import { randomBytes } from 'node:crypto';
import {
  DepositPartnerError,
  type DepositPartner,
  type PartnerBatch,
  type PartnerBatchUpdate,
} from './deposit-partner';

/**
 * Plays the payments partner until one is contracted (development, tests, demos). A batch waits
 * until someone settles it or returns an entry (`settle`, `returnEntry`), which the app offers in
 * stand-in mode. It keeps entry ids only, never account numbers.
 */
export class StandInDepositPartner implements DepositPartner {
  readonly name = 'stand-in';
  readonly standIn = true;
  private readonly batches = new Map<
    string,
    { entryIds: Set<string>; update: PartnerBatchUpdate }
  >();
  private failures: Error[] = [];

  submit(batch: PartnerBatch): Promise<{ reference: string }> {
    const failure = this.failures.shift();
    if (failure) return Promise.reject(failure);
    if (batch.entries.some((e) => !/^\d{9}$/.test(e.routingNumber)))
      return Promise.reject(new DepositPartnerError('A routing number is not valid.'));
    const reference = `DD${randomBytes(6).toString('hex').toUpperCase()}`;
    this.batches.set(reference, {
      entryIds: new Set(batch.entries.map((e) => e.entryId)),
      update: { reference, settled: false, returns: [] },
    });
    return Promise.resolve({ reference });
  }

  updates(references: string[]): Promise<PartnerBatchUpdate[]> {
    return Promise.resolve(
      references.flatMap((r) => {
        const b = this.batches.get(r);
        return b && (b.update.settled || b.update.returns.length)
          ? [structuredClone(b.update)]
          : [];
      }),
    );
  }

  /** The stand-in settles a batch (the entries not returned are paid). */
  settle(reference: string): void {
    this.entry(reference).update.settled = true;
  }

  /** The stand-in returns one entry, as the employee's bank would. */
  returnEntry(reference: string, entryId: string, code: string, reason: string): void {
    this.entry(reference).update.returns.push({ entryId, code, reason });
  }

  /** Tests: make the next submissions fail. */
  failNext(...errors: Error[]): void {
    this.failures.push(...errors);
  }

  private entry(reference: string) {
    let b = this.batches.get(reference);
    if (!b) {
      // A batch sent before a restart: the stand-in answers by reference alone.
      b = { entryIds: new Set(), update: { reference, settled: false, returns: [] } };
      this.batches.set(reference, b);
    }
    return b;
  }
}
