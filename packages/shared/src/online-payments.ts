import { z } from 'zod';
import { isoDate } from './fields';

/**
 * Online payments (Phase 10e, ADR 0022): customers pay invoices by card or bank (ACH) through
 * the company's own Stripe account (Stripe Connect, Standard accounts). Successful payments are
 * recorded as Receive Payments into Undeposited Funds; each Stripe payout becomes one bank
 * deposit with its fees, refunds and chargebacks.
 */

export const PAYMENT_PROVIDERS = ['stripe', 'mock'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

export const ONLINE_PAYMENT_METHODS = ['card', 'us_bank_account'] as const;
export type OnlinePaymentMethod = (typeof ONLINE_PAYMENT_METHODS)[number];
export const ONLINE_PAYMENT_METHOD_LABELS: Record<OnlinePaymentMethod, string> = {
  card: 'Card',
  us_bank_account: 'Bank transfer (ACH)',
};

export type PaymentAccountStatus = 'pending' | 'active' | 'restricted' | 'disconnected';

export interface PaymentAccountDto {
  provider: PaymentProvider;
  accountId: string;
  status: PaymentAccountStatus;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  /** What the processor still needs from the business before it can take payments. */
  requirements: string | null;
  acceptCard: boolean;
  acceptAch: boolean;
  depositAccountId: string;
  feeAccountId: string;
  refundAccountId: string;
  chargebackAccountId: string;
  connectedBy: string | null;
  updatedAt: string;
}

export interface OnlinePaymentsSettingsDto {
  /** The processor this installation uses; null when online payments are off. */
  provider: PaymentProvider | null;
  account: PaymentAccountDto | null;
}

export const connectPaymentsSchema = z.object({
  /** The bank account Stripe payouts are deposited to. */
  depositAccountId: z.uuid('Choose the bank account payouts go to'),
});
export type ConnectPaymentsInput = z.infer<typeof connectPaymentsSchema>;

export const paymentAccountUpdateSchema = z
  .object({
    acceptCard: z.boolean(),
    acceptAch: z.boolean(),
    depositAccountId: z.uuid(),
    feeAccountId: z.uuid(),
    refundAccountId: z.uuid(),
    chargebackAccountId: z.uuid(),
  })
  .partial()
  .refine((v) => v.acceptCard !== false || v.acceptAch !== false, {
    message: 'Accept at least one way to pay',
    path: ['acceptCard'],
  });
export type PaymentAccountUpdate = z.infer<typeof paymentAccountUpdateSchema>;

export type OnlinePaymentStatus = 'started' | 'processing' | 'succeeded' | 'failed' | 'canceled';

export interface OnlinePaymentDto {
  id: string;
  invoiceId: string;
  invoiceNumber: string | null;
  customerName: string | null;
  method: OnlinePaymentMethod | null;
  amount: string;
  status: OnlinePaymentStatus;
  refunded: string;
  disputeStatus: 'open' | 'won' | 'lost' | null;
  failureMessage: string | null;
  paymentTxnId: string | null;
  /** The processor's id for the payment (Stripe PaymentIntent), to find it in its dashboard. */
  paymentIntentId: string | null;
  createdAt: string;
  succeededAt: string | null;
}

export const PAYOUT_ITEM_KINDS = [
  'charge',
  'refund',
  'dispute',
  'dispute_reversal',
  'other',
] as const;
export type PayoutItemKind = (typeof PAYOUT_ITEM_KINDS)[number];

/** One balance movement in a payout: amounts in dollars, signed as the payout sees them. */
export interface PayoutItem {
  kind: PayoutItemKind;
  /** Gross: a charge is positive, a refund or chargeback negative. */
  amount: string;
  /** The processor's fee on it (positive is a cost; negative is a fee given back). */
  fee: string;
  paymentIntentId: string | null;
  description: string | null;
}

export interface PayoutDto {
  id: string;
  payoutId: string;
  amount: string;
  arrivalDate: string;
  status: 'recorded' | 'review' | 'failed';
  message: string | null;
  items: PayoutItem[];
  depositTxnId: string | null;
}

export interface OnlinePaymentsActivityDto {
  payments: OnlinePaymentDto[];
  payouts: PayoutDto[];
}

export interface PayLinkDto {
  url: string;
}

/** What a customer sees on the pay page (no sign-in: the link is the credential). */
export interface PublicInvoiceDto {
  companyName: string;
  companyEmail: string | null;
  companyPhone: string | null;
  customerName: string | null;
  number: string | null;
  txnDate: string;
  dueDate: string | null;
  lines: Array<{ description: string; amount: string }>;
  subtotal: string;
  taxLines: Array<{ name: string; amount: string }>;
  total: string;
  balance: string;
  /** payable; processing (a bank payment is on its way); paid; unavailable (see reason). */
  status: 'payable' | 'processing' | 'paid' | 'unavailable';
  reason: string | null;
  methods: OnlinePaymentMethod[];
}

export const checkoutSchema = z.object({
  method: z.enum(ONLINE_PAYMENT_METHODS).optional(),
});
export type CheckoutInput = z.infer<typeof checkoutSchema>;

// ---------------------------------------------------------------------------------------------
// The stand-in processor (development, tests and demos until the platform's Stripe keys exist).
// Its pages post these to /webhooks/payments/mock; they are refused unless the stand-in is on.
// ---------------------------------------------------------------------------------------------
export const mockPaymentActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('finish_onboarding'), accountId: z.string().min(1).max(255) }),
  z.object({
    action: z.literal('pay'),
    sessionId: z.string().min(1).max(255),
    method: z.enum(ONLINE_PAYMENT_METHODS),
  }),
  z.object({ action: z.literal('cancel'), sessionId: z.string().min(1).max(255) }),
  z.object({
    action: z.literal('bank_result'),
    paymentIntentId: z.string().min(1).max(255),
    succeeded: z.boolean(),
  }),
  z.object({
    action: z.literal('refund'),
    paymentIntentId: z.string().min(1).max(255),
    amount: z.string().regex(/^\d{1,13}(\.\d{1,2})?$/),
  }),
  z.object({
    action: z.literal('dispute'),
    paymentIntentId: z.string().min(1).max(255),
    status: z.enum(['open', 'won', 'lost']),
  }),
  z.object({
    action: z.literal('payout'),
    accountId: z.string().min(1).max(255),
    arrivalDate: isoDate,
  }),
]);
export type MockPaymentAction = z.infer<typeof mockPaymentActionSchema>;
