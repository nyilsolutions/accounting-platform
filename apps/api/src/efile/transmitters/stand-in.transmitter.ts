import { randomBytes } from 'node:crypto';
import type { EfileChannel } from '@acct/shared';
import {
  EfileTransmitError,
  type EfileAck,
  type EfileReturn,
  type EfileTransmitter,
} from './efile-transmitter';

const ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * Plays the IRS until the platform's own transmitter is approved (development, tests, demos).
 * It receives any return and holds it until someone decides the answer (`decide`): the app
 * offers that in stand-in mode, as the payments stand-in offers its checkout. It keeps only what
 * it needs to answer, never the EIN or TINs.
 */
export class StandInTransmitter implements EfileTransmitter {
  readonly name = 'stand-in';
  readonly standIn = true;
  private readonly received = new Map<string, { channel: EfileChannel; label: string }>();
  private readonly answers = new Map<string, EfileAck>();
  private failures: (Error | EfileTransmitError)[] = [];

  constructor(readonly environment: 'test' | 'production' = 'production') {}

  supports(): boolean {
    return true;
  }

  transmit(ret: EfileReturn): Promise<{ submissionId: string }> {
    const failure = this.failures.shift();
    if (failure) return Promise.reject(failure);
    if (!/^\d{9}$/.test(ret.filer.ein))
      return Promise.reject(new EfileTransmitError('The EIN must be nine digits.'));
    const bytes = randomBytes(14);
    const id = `SI${[...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('')}`;
    this.received.set(id, {
      channel: ret.channel,
      label: `${ret.form} ${ret.taxYear}${ret.quarter ? ` Q${ret.quarter}` : ''}`,
    });
    return Promise.resolve({ submissionId: id });
  }

  acknowledgments(_channel: EfileChannel, submissionIds: string[]): Promise<EfileAck[]> {
    return Promise.resolve(
      submissionIds.flatMap((id) => {
        const a = this.answers.get(id);
        return a ? [a] : [];
      }),
    );
  }

  /** The stand-in's answer for a submission (it may not remember one sent before a restart). */
  decide(submissionId: string, ack: Omit<EfileAck, 'submissionId' | 'acknowledgedAt'>): void {
    this.answers.set(submissionId, { ...ack, submissionId, acknowledgedAt: new Date() });
  }

  /** Tests: make the next transmissions fail (an `EfileTransmitError` or any other error). */
  failNext(...errors: (Error | EfileTransmitError)[]): void {
    this.failures.push(...errors);
  }

  /** Tests: what it holds, by submission id ("form_941 2026 Q1"). */
  holding(): Map<string, string> {
    return new Map([...this.received].map(([id, r]) => [id, r.label]));
  }
}
