import { z } from 'zod';
import { isoDate, optDate, optText, positiveAmount, qtyRate, signedAmount } from './fields';
import { MAX_AMOUNT, tryParseMoney } from './money';
import {
  resolveLineAmount,
  type AppliedDto,
  type DocumentStatus,
  type PaymentStatus,
} from './sales';

// ---------------------------------------------------------------------------------------------
// Document types
// ---------------------------------------------------------------------------------------------
export const PURCHASE_DOC_TYPES = [
  'bill',
  'vendor_credit',
  'check',
  'expense',
  'cc_credit',
] as const;
export type PurchaseDocType = (typeof PURCHASE_DOC_TYPES)[number];

/** URL segment for each document type (`/companies/:id/purchases/:slug`). */
export const PURCHASE_DOC_SLUGS: Record<PurchaseDocType, string> = {
  bill: 'bills',
  vendor_credit: 'vendor-credits',
  check: 'checks',
  expense: 'expenses',
  cc_credit: 'credit-card-credits',
};
export const PURCHASE_DOC_BY_SLUG: Record<string, PurchaseDocType> = Object.fromEntries(
  Object.entries(PURCHASE_DOC_SLUGS).map(([type, slug]) => [slug, type as PurchaseDocType]),
);

/** Documents paid at once from a bank or credit card account (no A/P). */
export const CASH_PURCHASE_TYPES: readonly PurchaseDocType[] = ['check', 'expense', 'cc_credit'];

// ---------------------------------------------------------------------------------------------
// Lines: a category (account) or a product/service, optionally for a customer/job
// ---------------------------------------------------------------------------------------------
const purchaseLineBase = z.object({
  itemId: z.uuid().nullable().optional(),
  /** Expense (or other) account; defaults to the item's expense account. */
  accountId: z.uuid().nullable().optional(),
  description: optText(4000),
  quantity: qtyRate,
  rate: qtyRate,
  amount: signedAmount,
  /** The customer or job the cost was for (job costing). */
  customerId: z.uuid().nullable().optional(),
  classId: z.uuid().nullable().optional(),
});

function lineIssues(lines: Array<z.infer<typeof purchaseLineBase>>, ctx: z.RefinementCtx): void {
  lines.forEach((l, i) => {
    if (!l.itemId && !l.accountId) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines', i, 'accountId'],
        message: 'Choose a category (account) or a product/service',
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
}

export const purchaseDocumentInputSchema = z
  .object({
    /** Required on bills and vendor credits; optional payee on checks and expenses. */
    vendorId: z.uuid().nullable().optional(),
    txnDate: isoDate,
    /** Bill no. (the vendor's invoice number), check no. or reference no. */
    number: optText(30),
    dueDate: optDate,
    termsId: z.uuid().nullable().optional(),
    /** Bank or credit card that paid (checks, expenses, credit card credits). */
    paymentAccountId: z.uuid().nullable().optional(),
    paymentMethodId: z.uuid().nullable().optional(),
    /** Checks: leave the number blank and print later from the print queue. */
    printLater: z.boolean().optional(),
    mailingAddress: optText(1000),
    memo: optText(4000),
    lines: z.array(purchaseLineBase).min(1, 'Add at least one line').max(1000),
    closingPassword: z.string().max(128).optional(),
    version: z.number().int().min(1).optional(),
  })
  .superRefine((d, ctx) => {
    lineIssues(d.lines, ctx);
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
        message: 'The due date cannot be before the bill date',
      });
    }
  });
export type PurchaseDocumentInput = z.input<typeof purchaseDocumentInputSchema>;

export interface PurchaseLineDto {
  lineNo: number;
  itemId: string | null;
  itemName: string | null;
  accountId: string;
  description: string | null;
  quantity: string | null;
  rate: string | null;
  amount: string;
  customerId: string | null;
  classId: string | null;
}

export type PrintStatus = 'to_print' | 'printed';

export interface PurchaseDocumentDto {
  id: string;
  txnType: PurchaseDocType;
  number: string | null;
  txnDate: string;
  dueDate: string | null;
  vendorId: string | null;
  vendorName: string | null;
  termsId: string | null;
  paymentAccountId: string | null;
  paymentMethodId: string | null;
  printStatus: PrintStatus | null;
  mailingAddress: string | null;
  memo: string | null;
  lines: PurchaseLineDto[];
  total: string;
  /** Still owed (bill) or still available (vendor credit); 0 for checks and expenses. */
  balance: string;
  status: DocumentStatus;
  paymentStatus: PaymentStatus;
  /** Bill payments (for a bill) or bills it was applied to (vendor credit). */
  applied: AppliedDto[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------------------------
// Bill payments
// ---------------------------------------------------------------------------------------------
const applications = z
  .array(z.object({ targetId: z.uuid(), amount: positiveAmount }))
  .min(1, 'Choose at least one bill')
  .max(1000)
  .superRefine((apps, ctx) => {
    const ids = new Set<string>();
    apps.forEach((a, i) => {
      if (ids.has(a.targetId))
        ctx.addIssue({ code: 'custom', path: [i, 'targetId'], message: 'Listed twice' });
      ids.add(a.targetId);
      if (tryParseMoney(a.amount) === 0n)
        ctx.addIssue({
          code: 'custom',
          path: [i, 'amount'],
          message: 'Enter an amount greater than zero',
        });
    });
  });

/** One vendor's payment. The amount paid is bills − vendor credits applied. */
export const billPaymentInputSchema = z.object({
  vendorId: z.uuid('Choose a vendor'),
  txnDate: isoDate,
  paymentAccountId: z.uuid('Choose the bank or credit card account'),
  /** Check number (bank) or reference. */
  number: optText(30),
  printLater: z.boolean().optional(),
  mailingAddress: optText(1000),
  memo: optText(4000),
  applications,
  closingPassword: z.string().max(128).optional(),
  version: z.number().int().min(1).optional(),
});
export type BillPaymentInput = z.input<typeof billPaymentInputSchema>;

/** Pay bills: one bill payment per vendor, all from the same account on the same date. */
export const payBillsInputSchema = z.object({
  txnDate: isoDate,
  paymentAccountId: z.uuid('Choose the bank or credit card account'),
  printLater: z.boolean().optional(),
  /** First check number, used in vendor order when not printing later. */
  firstCheckNumber: z
    .string()
    .trim()
    .regex(/^\d{1,12}$/, 'Enter a check number')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  applications,
  closingPassword: z.string().max(128).optional(),
});
export type PayBillsInput = z.input<typeof payBillsInputSchema>;

export interface OpenBillDto {
  id: string;
  txnType: 'bill' | 'vendor_credit';
  vendorId: string;
  vendorName: string;
  number: string | null;
  txnDate: string;
  dueDate: string | null;
  total: string;
  /** Open balance before this payment. */
  open: string;
}

export interface BillPaymentDto {
  id: string;
  vendorId: string;
  vendorName: string;
  txnDate: string;
  number: string | null;
  amount: string;
  paymentAccountId: string;
  printStatus: PrintStatus | null;
  mailingAddress: string | null;
  memo: string | null;
  applications: Array<AppliedDto & { targetType: string }>;
  status: DocumentStatus;
  version: number;
}

// ---------------------------------------------------------------------------------------------
// Check printing
// ---------------------------------------------------------------------------------------------
export interface CheckToPrintDto {
  id: string;
  txnType: 'check' | 'bill_payment';
  txnDate: string;
  payee: string | null;
  amount: string;
}

export const printChecksInputSchema = z.object({
  paymentAccountId: z.uuid(),
  firstCheckNumber: z
    .string()
    .trim()
    .regex(/^\d{1,12}$/, 'Enter the first check number'),
  ids: z.array(z.uuid()).min(1, 'Choose at least one check').max(500),
});
export type PrintChecksInput = z.input<typeof printChecksInputSchema>;

export interface PrintedCheckDto {
  id: string;
  number: string;
  txnDate: string;
  payee: string;
  mailingAddress: string | null;
  amount: string;
  amountInWords: string;
  memo: string | null;
  /** Voucher stub: bills paid, or expense lines. */
  stub: Array<{ description: string; amount: string }>;
  bankAccountName: string;
}

// ---------------------------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------------------------
export const PURCHASE_ORDER_STATUSES = ['open', 'closed'] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export const purchaseOrderInputSchema = z
  .object({
    vendorId: z.uuid('Choose a vendor'),
    txnDate: isoDate,
    expectedDate: optDate,
    number: optText(30),
    vendorAddress: optText(1000),
    shipTo: optText(1000),
    emailTo: optText(1000),
    vendorMessage: optText(4000),
    memo: optText(4000),
    lines: z.array(purchaseLineBase).min(1, 'Add at least one line').max(1000),
  })
  .superRefine((d, ctx) => lineIssues(d.lines, ctx));
export type PurchaseOrderInput = z.input<typeof purchaseOrderInputSchema>;

export interface PurchaseOrderDto {
  id: string;
  number: string | null;
  vendorId: string;
  vendorName: string;
  txnDate: string;
  expectedDate: string | null;
  status: PurchaseOrderStatus;
  vendorAddress: string | null;
  shipTo: string | null;
  emailTo: string | null;
  vendorMessage: string | null;
  memo: string | null;
  total: string;
  billId: string | null;
  lines: Array<Omit<PurchaseLineDto, 'accountId'> & { accountId: string | null }>;
}

export const purchaseOrderStatusSchema = z.object({ status: z.enum(PURCHASE_ORDER_STATUSES) });
export const convertPurchaseOrderSchema = z.object({
  txnDate: isoDate.optional(),
  closingPassword: z.string().max(128).optional(),
});

// ---------------------------------------------------------------------------------------------
// Lists and vendor center
// ---------------------------------------------------------------------------------------------
export const purchaseListQuerySchema = z.object({
  type: z.enum([...PURCHASE_DOC_TYPES, 'bill_payment', 'all'] as const).default('all'),
  vendorId: z.uuid().optional(),
  /** Bills only: open, overdue or paid. */
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
export type PurchaseListQuery = z.infer<typeof purchaseListQuerySchema>;

export interface PurchaseTransactionDto {
  id: string;
  txnType: string;
  txnDate: string;
  number: string | null;
  vendorId: string | null;
  vendorName: string | null;
  dueDate: string | null;
  total: string;
  balance: string;
  paymentStatus: PaymentStatus;
  printStatus: PrintStatus | null;
  status: DocumentStatus;
  memo: string | null;
}

export interface PurchaseTransactionPageDto {
  transactions: PurchaseTransactionDto[];
  nextCursor: string | null;
}

export interface VendorBalanceDto {
  vendorId: string;
  openBalance: string;
  overdueBalance: string;
  /** Unused vendor credits (positive amount). */
  availableCredit: string;
}

export const vendorFilterQuerySchema = z.object({ vendorId: z.uuid().optional() });
export const openBillsQuerySchema = z.object({
  vendorId: z.uuid().optional(),
  paymentId: z.uuid().optional(),
});
export const checksToPrintQuerySchema = z.object({ paymentAccountId: z.uuid() });
export const nextCheckNumberQuerySchema = z.object({ paymentAccountId: z.uuid() });

// ---------------------------------------------------------------------------------------------
// 1099 tracking
// ---------------------------------------------------------------------------------------------
export const FORM_1099_BOXES = ['nec_1', 'misc_1', 'misc_2', 'misc_3', 'misc_6'] as const;
export type Form1099Box = (typeof FORM_1099_BOXES)[number];
export const FORM_1099_BOX_LABELS: Record<Form1099Box, string> = {
  nec_1: '1099-NEC Box 1: Nonemployee compensation',
  misc_1: '1099-MISC Box 1: Rents',
  misc_2: '1099-MISC Box 2: Royalties',
  misc_3: '1099-MISC Box 3: Other income',
  misc_6: '1099-MISC Box 6: Medical and health care payments',
};

export const vendor1099MappingSchema = z.object({
  mappings: z
    .array(z.object({ accountId: z.uuid(), box: z.enum(FORM_1099_BOXES) }))
    .max(500)
    .superRefine((ms, ctx) => {
      const seen = new Set<string>();
      ms.forEach((m, i) => {
        if (seen.has(m.accountId))
          ctx.addIssue({ code: 'custom', path: [i, 'accountId'], message: 'Account mapped twice' });
        seen.add(m.accountId);
      });
    }),
});
export type Vendor1099MappingInput = z.input<typeof vendor1099MappingSchema>;

export interface Vendor1099MappingDto {
  accountId: string;
  box: Form1099Box;
}

export const year1099QuerySchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100),
});

export interface Vendor1099RowDto {
  vendorId: string;
  vendorName: string;
  tinMasked: string | null;
  hasAddress: boolean;
  boxes: Partial<Record<Form1099Box, string>>;
  total: string;
  /** Boxes whose amount meets that box's reporting threshold for the year. */
  reportableBoxes: Form1099Box[];
}

export interface Vendor1099SummaryDto {
  year: number;
  thresholds: Partial<Record<Form1099Box, string>>;
  source: string;
  vendors: Vendor1099RowDto[];
}
