/**
 * The platform as each company's EFTPS batch provider (ADR 0025). The EFTPS service only talks
 * to this interface:
 *
 * - the stand-in (`StandInEftpsBatch`) plays EFTPS until the platform is enrolled with the
 *   Treasury as a batch provider (development, tests and demos);
 * - the real batch provider implements it from the EFTPS batch provider specifications.
 *
 * Requests carry the full EIN and the debit account number: they are decrypted only to build
 * them, and neither the provider nor the service may store or log them.
 */
export interface EftpsBatchProvider {
  /** Recorded on each enrollment and payment, e.g. 'stand-in'. */
  readonly name: string;
  readonly standIn: boolean;
  /** Asks EFTPS to enroll the company; resolves with the provider's id for the request. */
  enroll(request: EftpsEnrollmentRequest): Promise<{ reference: string }>;
  /** Decisions on pending enrollments; those still pending are left out. */
  enrollmentUpdates(references: string[]): Promise<EftpsEnrollmentUpdate[]>;
  /** Schedules a payment; resolves with the EFT acknowledgement number. */
  schedule(payment: EftpsBatchPayment): Promise<{ reference: string }>;
  /** Cancels a scheduled payment; throws `EftpsProviderError` when it is too late. */
  cancel(reference: string): Promise<void>;
  /** Scheduled payments that settled or came back; those still scheduled are left out. */
  paymentUpdates(references: string[]): Promise<EftpsPaymentUpdate[]>;
}

export const EFTPS_BATCH_PROVIDER = Symbol('EFTPS_BATCH_PROVIDER');

/** The provider refused the request (nothing was enrolled, scheduled or cancelled). */
export class EftpsProviderError extends Error {}

export interface EftpsEnrollmentRequest {
  /** Nine digits. */
  ein: string;
  name: string;
  routingNumber: string;
  accountNumber: string;
  accountType: 'checking' | 'savings';
  authorizedName: string;
  authorizedTitle: string;
}

export interface EftpsEnrollmentUpdate {
  reference: string;
  status: 'enrolled' | 'rejected';
  message: string | null;
}

export interface EftpsBatchPayment {
  /** Nine digits. */
  ein: string;
  enrollmentReference: string;
  form: '941' | '940';
  taxYear: number;
  quarter: 1 | 2 | 3 | 4 | null;
  amount: string;
  settlementDate: string;
}

export interface EftpsPaymentUpdate {
  reference: string;
  status: 'settled' | 'returned';
  message: string | null;
}
