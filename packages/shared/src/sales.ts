import { z } from 'zod';
import { MAX_AMOUNT, moneyToString, parseMoney, tryParseMoney, type Money } from './money';
import { isoDate, optDate, optText, positiveAmount, qtyRate, signedAmount } from './fields';

// ---------------------------------------------------------------------------------------------
// Document types
// ---------------------------------------------------------------------------------------------
export const SALES_DOC_TYPES = [
  'invoice',
  'sales_receipt',
  'credit_memo',
  'refund_receipt',
] as const;
export type SalesDocType = (typeof SALES_DOC_TYPES)[number];

/** URL segment for each document type (`/companies/:id/sales/:slug`). */
export const SALES_DOC_SLUGS: Record<SalesDocType, string> = {
  invoice: 'invoices',
  sales_receipt: 'sales-receipts',
  credit_memo: 'credit-memos',
  refund_receipt: 'refund-receipts',
};
export const SALES_DOC_BY_SLUG: Record<string, SalesDocType> = Object.fromEntries(
  Object.entries(SALES_DOC_SLUGS).map(([type, slug]) => [slug, type as SalesDocType]),
);

export const TXN_TYPE_LABELS: Record<string, string> = {
  journal_entry: 'Journal Entry',
  invoice: 'Invoice',
  sales_receipt: 'Sales Receipt',
  credit_memo: 'Credit Memo',
  refund_receipt: 'Refund Receipt',
  payment: 'Payment',
  deposit: 'Deposit',
  estimate: 'Estimate',
  bill: 'Bill',
  vendor_credit: 'Vendor Credit',
  bill_payment: 'Bill Payment',
  check: 'Check',
  expense: 'Expense',
  cc_credit: 'Credit Card Credit',
  purchase_order: 'Purchase Order',
  transfer: 'Transfer',
  sales_tax_payment: 'Sales Tax Payment',
  sales_tax_adjustment: 'Sales Tax Adjustment',
};

/** Every transaction type that posts to the ledger. */
export const POSTING_TXN_TYPES = [
  'journal_entry',
  'invoice',
  'sales_receipt',
  'credit_memo',
  'refund_receipt',
  'payment',
  'deposit',
  'bill',
  'vendor_credit',
  'bill_payment',
  'check',
  'expense',
  'cc_credit',
  'transfer',
  'sales_tax_payment',
  'sales_tax_adjustment',
] as const;
export type PostingTxnType = (typeof POSTING_TXN_TYPES)[number];

// ---------------------------------------------------------------------------------------------
// Amount helpers shared by the web form and the API (the API recomputes; it never trusts totals)
// ---------------------------------------------------------------------------------------------

/** Line amount = quantity × rate, rounded half away from zero to cents. */
export function lineAmount(quantity: string, rate: string): Money {
  // Both parse to 1/10,000 units, so the product is in 1/100,000,000 units.
  const product = parseMoney(quantity) * parseMoney(rate);
  const perCent = 1_000_000n;
  const abs = product < 0n ? -product : product;
  const cents = (abs + perCent / 2n) / perCent;
  return (product < 0n ? -cents : cents) * 100n;
}

// ---------------------------------------------------------------------------------------------
// Sales documents (invoice, sales receipt, credit memo, refund receipt)
// ---------------------------------------------------------------------------------------------
const taxAmountOverride = z
  .string()
  .trim()
  .regex(/^\d{1,15}(\.\d{1,2})?$/, 'Enter the tax in dollars and cents')
  .nullable()
  .optional();

const salesLineBase = z.object({
  itemId: z.uuid().nullable().optional(),
  /** Income account; defaults to the item's income account. Required when no item is chosen. */
  accountId: z.uuid().nullable().optional(),
  description: optText(4000),
  quantity: qtyRate,
  rate: qtyRate,
  /** Ignored when both quantity and rate are given (amount = quantity × rate). Negative for discounts. */
  amount: signedAmount,
  classId: z.uuid().nullable().optional(),
  serviceDate: optDate,
  taxable: z.boolean().optional(),
});

export const salesLineInputSchema = salesLineBase.superRefine((l, ctx) => {
  if (!l.itemId && !l.accountId) {
    ctx.addIssue({
      code: 'custom',
      path: ['itemId'],
      message: 'Choose a product/service or an income account',
    });
  }
  if (!(l.quantity && l.rate) && !l.amount) {
    ctx.addIssue({
      code: 'custom',
      path: ['amount'],
      message: 'Enter an amount, or a quantity and rate',
    });
  }
});
export type SalesLineInput = z.input<typeof salesLineInputSchema>;

/** Resolves a line's amount exactly as the API does. */
export function resolveLineAmount(l: {
  quantity?: string | null;
  rate?: string | null;
  amount?: string | null;
}): Money {
  if (l.quantity && l.rate) return lineAmount(l.quantity, l.rate);
  return l.amount ? parseMoney(l.amount) : 0n;
}

export const salesDocumentInputSchema = z
  .object({
    customerId: z.uuid().nullable().optional(),
    txnDate: isoDate,
    number: optText(30),
    dueDate: optDate,
    termsId: z.uuid().nullable().optional(),
    billTo: optText(1000),
    emailTo: optText(1000),
    customerMessage: optText(4000),
    memo: optText(4000),
    paymentMethodId: z.uuid().nullable().optional(),
    reference: optText(50),
    depositAccountId: z.uuid().nullable().optional(),
    /** Sales tax rate charged on the taxable lines; null or absent charges none. */
    taxRateId: z.uuid().nullable().optional(),
    /** Overrides the calculated tax (e.g. entering a paper invoice); split across the components. */
    taxAmount: taxAmountOverride,
    lines: z.array(salesLineInputSchema).min(1, 'Add at least one line').max(1000),
    closingPassword: z.string().max(128).optional(),
    version: z.number().int().min(1).optional(),
  })
  .superRefine((d, ctx) => {
    const total = d.lines.reduce((s, l) => s + resolveLineAmount(l), 0n);
    if (total <= 0n)
      ctx.addIssue({
        code: 'custom',
        path: ['lines'],
        message: 'The total must be greater than zero',
      });
    if (total > MAX_AMOUNT)
      ctx.addIssue({ code: 'custom', path: ['lines'], message: 'The total is too large' });
    if (d.dueDate && d.dueDate < d.txnDate) {
      ctx.addIssue({
        code: 'custom',
        path: ['dueDate'],
        message: 'The due date cannot be before the invoice date',
      });
    }
  });
export type SalesDocumentInput = z.input<typeof salesDocumentInputSchema>;

export interface SalesLineDto {
  lineNo: number;
  itemId: string | null;
  itemName: string | null;
  accountId: string;
  description: string | null;
  quantity: string | null;
  rate: string | null;
  amount: string;
  classId: string | null;
  serviceDate: string | null;
  taxable: boolean;
}

export interface SalesTaxLineDto {
  agencyId: string;
  agencyName: string;
  taxRateId: string | null;
  rateName: string | null;
  rate: string | null;
  taxable: string;
  amount: string;
}

export interface AppliedDto {
  /** The other side of the application: a payment (for an invoice/credit) or the invoice/credit (for a payment). */
  txnId: string;
  txnType: string;
  number: string | null;
  txnDate: string;
  amount: string;
}

export type DocumentStatus = 'posted' | 'void';
/** Invoices: open/partial/paid/overdue. Credit memos: open (unused credit) or closed. Receipts: paid/deposited. */
export type PaymentStatus =
  'open' | 'partial' | 'paid' | 'overdue' | 'closed' | 'deposited' | 'void';

export interface SalesDocumentDto {
  id: string;
  txnType: SalesDocType;
  number: string | null;
  txnDate: string;
  dueDate: string | null;
  customerId: string | null;
  customerName: string | null;
  termsId: string | null;
  billTo: string | null;
  emailTo: string | null;
  customerMessage: string | null;
  memo: string | null;
  paymentMethodId: string | null;
  reference: string | null;
  depositAccountId: string | null;
  lines: SalesLineDto[];
  /** Sum of the lines, before tax. */
  subtotal: string;
  taxRateId: string | null;
  taxRateName: string | null;
  /** Tax charged, per agency and rate. */
  taxLines: SalesTaxLineDto[];
  taxTotal: string;
  /** Subtotal plus tax. */
  total: string;
  /** Amount still owed (invoice) or still available (credit memo); 0 for receipts. */
  balance: string;
  status: DocumentStatus;
  paymentStatus: PaymentStatus;
  applied: AppliedDto[];
  depositId: string | null;
  sentAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------------------------
// Receive payment
// ---------------------------------------------------------------------------------------------
export const paymentInputSchema = z
  .object({
    customerId: z.uuid('Choose a customer'),
    txnDate: isoDate,
    amount: positiveAmount,
    paymentMethodId: z.uuid().nullable().optional(),
    reference: optText(50),
    /** Undeposited Funds by default, or a bank account. */
    depositAccountId: z.uuid().nullable().optional(),
    memo: optText(4000),
    applications: z
      .array(z.object({ targetId: z.uuid(), amount: positiveAmount }))
      .max(1000)
      .default([]),
    closingPassword: z.string().max(128).optional(),
    version: z.number().int().min(1).optional(),
  })
  .superRefine((p, ctx) => {
    const ids = new Set<string>();
    p.applications.forEach((a, i) => {
      if (ids.has(a.targetId))
        ctx.addIssue({
          code: 'custom',
          path: ['applications', i, 'targetId'],
          message: 'Listed twice',
        });
      ids.add(a.targetId);
      if (tryParseMoney(a.amount) === 0n) {
        ctx.addIssue({
          code: 'custom',
          path: ['applications', i, 'amount'],
          message: 'Enter an amount greater than zero',
        });
      }
    });
    if (tryParseMoney(p.amount) === 0n && p.applications.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'Enter the amount received or choose credits to apply',
      });
    }
  });
export type PaymentInput = z.input<typeof paymentInputSchema>;

export interface OpenItemDto {
  id: string;
  txnType: 'invoice' | 'credit_memo' | 'payment';
  number: string | null;
  txnDate: string;
  dueDate: string | null;
  total: string;
  /** Open balance before this payment. */
  open: string;
}

export interface PaymentDto {
  id: string;
  customerId: string;
  customerName: string;
  txnDate: string;
  amount: string;
  paymentMethodId: string | null;
  reference: string | null;
  depositAccountId: string | null;
  memo: string | null;
  applications: Array<AppliedDto & { targetType: string }>;
  /** Overpayment held as a customer credit. */
  unapplied: string;
  depositId: string | null;
  status: DocumentStatus;
  version: number;
}

// ---------------------------------------------------------------------------------------------
// Deposits
// ---------------------------------------------------------------------------------------------
export const depositInputSchema = z
  .object({
    txnDate: isoDate,
    depositAccountId: z.uuid('Choose the bank account'),
    memo: optText(4000),
    lines: z
      .array(
        z.object({
          /** A payment or sales receipt waiting in Undeposited Funds. Its amount and account come from it. */
          sourceTxnId: z.uuid().nullable().optional(),
          accountId: z.uuid().nullable().optional(),
          amount: positiveAmount.optional(),
          customerId: z.uuid().nullable().optional(),
          description: optText(4000),
          paymentMethodId: z.uuid().nullable().optional(),
          reference: optText(50),
          classId: z.uuid().nullable().optional(),
        }),
      )
      .min(1, 'Choose at least one payment or add a line')
      .max(1000),
    closingPassword: z.string().max(128).optional(),
    version: z.number().int().min(1).optional(),
  })
  .superRefine((d, ctx) => {
    d.lines.forEach((l, i) => {
      if (!l.sourceTxnId && (!l.accountId || !l.amount || tryParseMoney(l.amount) === 0n)) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines', i, 'accountId'],
          message: 'Choose an account and enter an amount',
        });
      }
    });
  });
export type DepositInput = z.input<typeof depositInputSchema>;

export interface PendingDepositDto {
  txnId: string;
  txnType: 'payment' | 'sales_receipt';
  txnDate: string;
  number: string | null;
  customerId: string | null;
  customerName: string | null;
  paymentMethodId: string | null;
  reference: string | null;
  amount: string;
}

export interface DepositLineDto {
  lineNo: number;
  sourceTxnId: string | null;
  sourceTxnType: string | null;
  accountId: string;
  amount: string;
  customerId: string | null;
  customerName: string | null;
  description: string | null;
  paymentMethodId: string | null;
  reference: string | null;
  classId: string | null;
}

export interface DepositDto {
  id: string;
  txnDate: string;
  depositAccountId: string;
  memo: string | null;
  total: string;
  lines: DepositLineDto[];
  status: DocumentStatus;
  version: number;
}

// ---------------------------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------------------------
export const ESTIMATE_STATUSES = ['pending', 'accepted', 'rejected', 'closed'] as const;
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];

export const estimateInputSchema = z
  .object({
    customerId: z.uuid('Choose a customer'),
    txnDate: isoDate,
    expirationDate: optDate,
    number: optText(30),
    billTo: optText(1000),
    emailTo: optText(1000),
    customerMessage: optText(4000),
    memo: optText(4000),
    status: z.enum(ESTIMATE_STATUSES).optional(),
    taxRateId: z.uuid().nullable().optional(),
    lines: z.array(salesLineBase).min(1).max(1000),
  })
  .superRefine((e, ctx) => {
    e.lines.forEach((l, i) => {
      if (!l.itemId && !l.accountId) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines', i, 'itemId'],
          message: 'Choose a product/service or an income account',
        });
      }
      if (!(l.quantity && l.rate) && !l.amount) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines', i, 'amount'],
          message: 'Enter an amount, or a quantity and rate',
        });
      }
    });
  });
export type EstimateInput = z.input<typeof estimateInputSchema>;

export interface EstimateDto {
  id: string;
  number: string | null;
  customerId: string;
  customerName: string;
  txnDate: string;
  expirationDate: string | null;
  status: EstimateStatus;
  billTo: string | null;
  emailTo: string | null;
  customerMessage: string | null;
  memo: string | null;
  subtotal: string;
  taxRateId: string | null;
  taxTotal: string;
  total: string;
  invoiceId: string | null;
  sentAt: string | null;
  lines: Array<Omit<SalesLineDto, 'accountId'> & { accountId: string | null }>;
}

// ---------------------------------------------------------------------------------------------
// Lists, customer center, statements
// ---------------------------------------------------------------------------------------------
export const salesListQuerySchema = z.object({
  type: z.enum([...SALES_DOC_TYPES, 'payment', 'deposit', 'all'] as const).default('all'),
  customerId: z.uuid().optional(),
  status: z.enum(['all', 'open', 'overdue', 'paid']).default('all'),
  from: isoDate.optional(),
  to: isoDate.optional(),
  search: z.string().trim().max(100).optional(),
  includeVoid: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SalesListQuery = z.infer<typeof salesListQuerySchema>;

export interface SalesTransactionDto {
  id: string;
  txnType: string;
  txnDate: string;
  number: string | null;
  customerId: string | null;
  customerName: string | null;
  dueDate: string | null;
  total: string;
  balance: string;
  paymentStatus: PaymentStatus;
  status: DocumentStatus;
  memo: string | null;
}

export interface SalesTransactionPageDto {
  transactions: SalesTransactionDto[];
  nextCursor: string | null;
}

export interface CustomerBalanceDto {
  customerId: string;
  openBalance: string;
  overdueBalance: string;
  /** Unused credit memos and unapplied payments (shown as a positive amount). */
  availableCredit: string;
}

export const statementQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
});

export interface StatementDto {
  companyName: string;
  companyAddress: string | null;
  customerId: string;
  customerName: string;
  billTo: string | null;
  from: string;
  to: string;
  openingBalance: string;
  rows: Array<{
    txnId: string | null;
    txnType: string;
    txnDate: string;
    number: string | null;
    description: string;
    amount: string;
    balance: string;
  }>;
  endingBalance: string;
  aging: AgingBuckets;
}

export interface AgingBuckets {
  current: string;
  days1to30: string;
  days31to60: string;
  days61to90: string;
  over90: string;
  total: string;
}

export const sendDocumentSchema = z.object({
  to: z
    .string()
    .trim()
    .min(3, 'Enter at least one email address')
    .max(1000)
    .refine(
      (v) => v.split(/[,;]\s*/).every((e) => z.email().safeParse(e.trim()).success),
      'Enter valid email addresses separated by commas',
    ),
  message: optText(4000),
});
export type SendDocumentInput = z.input<typeof sendDocumentSchema>;

/** Due date from terms (net days after the document date). */
export function dueDateFromTerms(txnDate: string, dueDays: number): string {
  const d = new Date(`${txnDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dueDays);
  return d.toISOString().slice(0, 10);
}

export function money2(v: Money): string {
  return moneyToString(v, 2);
}

export const estimateStatusSchema = z.object({
  status: z.enum(['pending', 'accepted', 'rejected']),
});

export const convertEstimateSchema = z.object({
  txnDate: isoDate.optional(),
  closingPassword: z.string().max(128).optional(),
});

export const openItemsQuerySchema = z.object({
  paymentId: z.uuid().optional(),
});

export const customerFilterQuerySchema = z.object({
  customerId: z.uuid().optional(),
});

export const pendingDepositsQuerySchema = z.object({
  depositId: z.uuid().optional(),
});
