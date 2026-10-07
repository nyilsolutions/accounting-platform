import { randomInt } from 'node:crypto';
import { todayIso } from '@acct/shared';
import {
  EftpsProviderError,
  type EftpsBatchPayment,
  type EftpsBatchProvider,
  type EftpsEnrollmentRequest,
  type EftpsEnrollmentUpdate,
  type EftpsPaymentUpdate,
} from './eftps-batch';

const digits = (n: number) => Array.from({ length: n }, () => randomInt(10)).join('');

/**
 * Plays EFTPS until the platform is a batch provider (development, tests, demos). Enrollments
 * and payments wait until someone answers for EFTPS (`decide…`), which the app offers in
 * stand-in mode. It keeps only what it needs to answer, never the EIN or account numbers.
 */
export class StandInEftpsBatch implements EftpsBatchProvider {
  readonly name = 'stand-in';
  readonly standIn = true;
  private readonly enrollments = new Map<string, EftpsEnrollmentUpdate>();
  private readonly payments = new Map<
    string,
    { settlementDate: string; answer: EftpsPaymentUpdate | null; cancelled: boolean }
  >();
  private failures: Error[] = [];

  enroll(request: EftpsEnrollmentRequest): Promise<{ reference: string }> {
    const failure = this.failures.shift();
    if (failure) return Promise.reject(failure);
    if (!/^\d{9}$/.test(request.ein))
      return Promise.reject(new EftpsProviderError('The EIN must be nine digits.'));
    return Promise.resolve({ reference: `EN${digits(10)}` });
  }

  enrollmentUpdates(references: string[]): Promise<EftpsEnrollmentUpdate[]> {
    return Promise.resolve(references.flatMap((r) => this.enrollments.get(r) ?? []));
  }

  schedule(payment: EftpsBatchPayment): Promise<{ reference: string }> {
    const failure = this.failures.shift();
    if (failure) return Promise.reject(failure);
    // The stand-in's own rule; the real cut-off times come with the batch specifications.
    if (payment.settlementDate <= todayIso())
      return Promise.reject(new EftpsProviderError('The settlement date must be after today.'));
    const reference = `27${digits(13)}`;
    this.payments.set(reference, {
      settlementDate: payment.settlementDate,
      answer: null,
      cancelled: false,
    });
    return Promise.resolve({ reference });
  }

  cancel(reference: string): Promise<void> {
    const p = this.payments.get(reference);
    if (p?.answer)
      return Promise.reject(new EftpsProviderError('The payment has already settled.'));
    if (p && p.settlementDate <= todayIso())
      return Promise.reject(new EftpsProviderError('It is too late to cancel this payment.'));
    if (p) p.cancelled = true;
    return Promise.resolve();
  }

  paymentUpdates(references: string[]): Promise<EftpsPaymentUpdate[]> {
    return Promise.resolve(references.flatMap((r) => this.payments.get(r)?.answer ?? []));
  }

  /** The stand-in's answer to an enrollment. */
  decideEnrollment(reference: string, status: 'enrolled' | 'rejected', message?: string): void {
    this.enrollments.set(reference, { reference, status, message: message ?? null });
  }

  /** The stand-in's answer to a payment (it may not remember one sent before a restart). */
  decidePayment(reference: string, status: 'settled' | 'returned', message?: string): void {
    const p = this.payments.get(reference) ?? {
      settlementDate: todayIso(),
      answer: null,
      cancelled: false,
    };
    p.answer = { reference, status, message: message ?? null };
    this.payments.set(reference, p);
  }

  /** Tests: make the next requests fail. */
  failNext(...errors: Error[]): void {
    this.failures.push(...errors);
  }
}
