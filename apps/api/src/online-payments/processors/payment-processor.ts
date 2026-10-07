import type { OnlinePaymentMethod, PaymentProvider, PayoutItem } from '@acct/shared';

/**
 * The seam between online payments and a card/bank processor (ADR 0022). Stripe Connect is the
 * live implementation (each business has its own Standard account and charges are made on it
 * directly); the stand-in serves development, tests and demos until the platform's Stripe keys
 * exist. Amounts are dollar strings; the processor converts to its own units.
 */
export const PAYMENT_PROCESSOR = Symbol('PAYMENT_PROCESSOR');

export interface ProcessorAccount {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  /** What the business still has to give the processor, in plain words; null when nothing. */
  requirements: string | null;
}

export interface CheckoutRequest {
  accountId: string;
  /** Our online payment id: the processor's idempotency key and client reference. */
  reference: string;
  amount: string;
  /** Shown on the checkout page, e.g. "Invoice 1042 from Sample Landscaping Co.". */
  description: string;
  customerEmail: string | null;
  methods: OnlinePaymentMethod[];
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}

export interface ProcessorPayment {
  status: 'processing' | 'succeeded' | 'failed' | 'canceled';
  chargeId: string | null;
  method: OnlinePaymentMethod | null;
  amount: string;
  /** When the money was taken (the payment's date in the books). */
  date: string;
  failureMessage: string | null;
}

/** A processor webhook, reduced to what the books need. */
export type PaymentEvent = { id: string; accountId: string } & (
  | { type: 'account.updated' }
  | {
      type: 'checkout.completed';
      sessionId: string;
      paymentIntentId: string | null;
      /** False for bank payments still on their way (they succeed or fail days later). */
      paid: boolean;
    }
  | { type: 'checkout.succeeded'; sessionId: string; paymentIntentId: string | null }
  | {
      type: 'checkout.failed';
      sessionId: string;
      paymentIntentId: string | null;
      message: string | null;
    }
  | { type: 'checkout.expired'; sessionId: string }
  | { type: 'charge.refunded'; paymentIntentId: string; amountRefunded: string }
  | { type: 'dispute.updated'; paymentIntentId: string; status: 'open' | 'won' | 'lost' }
  | {
      type: 'payout.paid' | 'payout.failed';
      payoutId: string;
      amount: string;
      arrivalDate: string;
      message: string | null;
    }
);

export interface PaymentProcessor {
  readonly name: PaymentProvider;
  /** Creates the business's connected account (Stripe Standard). */
  createAccount(opts: { email: string | null; businessName: string }): Promise<string>;
  /** A one-time link to the processor's onboarding for the account. */
  onboardingUrl(accountId: string, returnUrl: string, refreshUrl: string): Promise<string>;
  getAccount(accountId: string): Promise<ProcessorAccount>;
  createCheckout(req: CheckoutRequest): Promise<{ sessionId: string; url: string }>;
  getPayment(accountId: string, paymentIntentId: string): Promise<ProcessorPayment>;
  /** Everything a payout carried (charges, refunds, disputes), with the processor's fees. */
  payoutItems(accountId: string, payoutId: string): Promise<PayoutItem[]>;
  /** Verifies a webhook's signature and reads it; null when it isn't authentic or not needed. */
  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): Promise<PaymentEvent | 'ignored' | null>;
}

/** A processor refusal the user can act on (shown as a 400 with the processor's message). */
export class ProcessorError extends Error {}
