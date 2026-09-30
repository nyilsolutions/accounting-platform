import { z } from 'zod';
import { isIsoDate, monthEndOf } from './dates';
import { isoDate, optText, positiveAmount } from './fields';

/**
 * Accountant tools (Phase 10d, ADR 0021): reclassify transactions, write off invoices, fix
 * undeposited funds, review client changes, and the month-end close.
 */

// ---------------------------------------------------------------------------------------------
// Reclassify transactions
// ---------------------------------------------------------------------------------------------
export const RECLASSIFY_TXN_TYPES = [
  'journal_entry',
  'invoice',
  'sales_receipt',
  'credit_memo',
  'refund_receipt',
  'bill',
  'vendor_credit',
  'check',
  'expense',
  'cc_credit',
] as const;

export const reclassifyQuerySchema = z.object({
  accountId: z.uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  classId: z.union([z.uuid(), z.literal('none')]).optional(),
  customerId: z.uuid().optional(),
  vendorId: z.uuid().optional(),
  txnType: z.enum(RECLASSIFY_TXN_TYPES).optional(),
});
export type ReclassifyQuery = z.infer<typeof reclassifyQuerySchema>;

export interface ReclassifyLineDto {
  txnId: string;
  txnType: string;
  txnDate: string;
  number: string | null;
  lineNo: number;
  accountId: string;
  accountName: string;
  classId: string | null;
  className: string | null;
  partyName: string | null;
  description: string | null;
  /** Debit − credit, in US dollars. */
  amount: string;
  /** Lines with a product or service keep its account; only their class can change. */
  canChangeAccount: boolean;
}

export const reclassifyInputSchema = z
  .object({
    lines: z
      .array(z.object({ txnId: z.uuid(), lineNo: z.number().int().min(1).max(1000) }))
      .min(1, 'Choose at least one line')
      .max(500),
    /** The new account; omitted keeps each line's account. */
    accountId: z.uuid().optional(),
    /** The new class; null removes it; omitted keeps each line's class. */
    classId: z.uuid().nullable().optional(),
    closingPassword: z.string().max(128).optional(),
  })
  .refine((v) => v.accountId !== undefined || v.classId !== undefined, {
    message: 'Choose a new account or class',
    path: ['accountId'],
  });
export type ReclassifyInput = z.input<typeof reclassifyInputSchema>;

export interface ReclassifyResultDto {
  lines: number;
  transactions: number;
}

// ---------------------------------------------------------------------------------------------
// Write off invoices
// ---------------------------------------------------------------------------------------------
export const writeOffQuerySchema = z.object({
  /** Only invoices at least this many days past due. */
  olderThanDays: z.coerce.number().int().min(0).max(3650).optional(),
  /** Only invoices with an open balance up to this amount (in the invoice's currency). */
  maxBalance: positiveAmount.optional(),
  customerId: z.uuid().optional(),
  asOf: isoDate.optional(),
});
export type WriteOffQuery = z.infer<typeof writeOffQuerySchema>;

export interface WriteOffCandidateDto {
  id: string;
  number: string | null;
  txnDate: string;
  dueDate: string | null;
  customerId: string;
  customerName: string;
  currency: string | null;
  balance: string;
  /** The balance's US dollar value in the books. */
  homeBalance: string;
  daysPastDue: number;
}

export const writeOffInputSchema = z.object({
  invoiceIds: z.array(z.uuid()).min(1, 'Choose at least one invoice').max(200),
  txnDate: isoDate,
  /** The expense account; omitted: Bad Debts (created if missing). */
  accountId: z.uuid().optional(),
  memo: optText(4000),
  closingPassword: z.string().max(128).optional(),
});
export type WriteOffInput = z.input<typeof writeOffInputSchema>;

export interface WriteOffResultDto {
  writtenOff: Array<{
    invoiceId: string;
    invoiceNumber: string | null;
    creditMemoId: string;
    paymentId: string;
    amount: string;
    currency: string | null;
  }>;
  /** US dollars written off. */
  total: string;
  accountId: string;
}

// ---------------------------------------------------------------------------------------------
// Fix undeposited funds
// ---------------------------------------------------------------------------------------------
export interface UndepositedPaymentDto {
  txnId: string;
  txnType: 'payment' | 'sales_receipt';
  txnDate: string;
  number: string | null;
  customerName: string | null;
  /** US dollars. */
  amount: string;
}

export interface DepositLineToFixDto {
  depositId: string;
  depositDate: string;
  bankAccountName: string;
  lineNo: number;
  accountId: string;
  accountName: string;
  customerName: string | null;
  description: string | null;
  amount: string;
  /** Payments waiting in Undeposited Funds for the same amount. */
  suggested: string[];
}

export interface UndepositedFundsDto {
  /** Payments and sales receipts still in Undeposited Funds. */
  waiting: UndepositedPaymentDto[];
  /** Deposit lines recorded straight to income (or another account) that may be those payments. */
  depositLines: DepositLineToFixDto[];
  undepositedBalance: string;
}

export const fixUndepositedSchema = z.object({
  depositId: z.uuid(),
  lineNo: z.number().int().min(1).max(1000),
  /** The payments the line really was; their amounts must add up to the line's. */
  sourceTxnIds: z.array(z.uuid()).min(1, 'Choose the payments').max(100),
  closingPassword: z.string().max(128).optional(),
});
export type FixUndepositedInput = z.input<typeof fixUndepositedSchema>;

// ---------------------------------------------------------------------------------------------
// Client changes
// ---------------------------------------------------------------------------------------------
export const clientChangesQuerySchema = z.object({
  status: z.enum(['unreviewed', 'reviewed', 'all']).default('unreviewed'),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type ClientChangesQuery = z.infer<typeof clientChangesQuerySchema>;

export interface ClientChangeDto {
  /** The audit log entry. */
  id: string;
  at: string;
  actorName: string | null;
  actorRole: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  txnType: string | null;
  txnNumber: string | null;
  txnDate: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** The transaction is (or was) dated on or before the closing date. */
  inClosedPeriod: boolean;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

export interface ClientChangesDto {
  changes: ClientChangeDto[];
  unreviewed: number;
}

const auditId = z.string().regex(/^\d{1,19}$/, 'Invalid change');
export const reviewChangesSchema = z.object({
  ids: z.array(auditId).min(1, 'Choose at least one change').max(500),
});

// ---------------------------------------------------------------------------------------------
// Month-end close
// ---------------------------------------------------------------------------------------------
export const CLOSE_STEPS = [
  'bank_reconciled',
  'undeposited_funds',
  'uncategorized',
  'client_changes',
  'revaluation',
  'receivables_payables',
] as const;
export type CloseStep = (typeof CLOSE_STEPS)[number];

export const CLOSE_STEP_LABELS: Record<CloseStep, string> = {
  bank_reconciled: 'Reconcile every bank and credit card account',
  undeposited_funds: 'Clear Undeposited Funds',
  uncategorized: 'Categorize everything in the Uncategorized accounts',
  client_changes: 'Review client changes',
  revaluation: 'Revalue foreign currencies',
  receivables_payables: 'Review A/R and A/P aging',
};

export type CloseStepStatus = 'done' | 'attention' | 'not_needed';

export interface CloseStepDto {
  step: CloseStep;
  label: string;
  status: CloseStepStatus;
  /** What the check found ("Checking reconciled through 2026-09-30"; "2 payments waiting"). */
  detail: string;
  /** Marked done by hand (overrides what the check found). */
  markedBy: string | null;
  markedAt: string | null;
  note: string | null;
}

export interface PeriodCloseDto {
  id: string;
  periodEnd: string;
  closedBy: string | null;
  closedAt: string;
  note: string | null;
}

export interface CloseChecklistDto {
  periodStart: string;
  periodEnd: string;
  steps: CloseStepDto[];
  /** Every step is done, marked done or not needed. */
  ready: boolean;
  closingDate: string | null;
  hasClosingPassword: boolean;
  closes: PeriodCloseDto[];
}

/** A month's last day ("2026-09-30"). */
export const periodEndSchema = z
  .string()
  .refine((v) => isIsoDate(v) && monthEndOf(v) === v, 'Choose the last day of a month');

export const closeMarkSchema = z.object({
  step: z.enum(CLOSE_STEPS),
  note: z.string().trim().min(1, 'Say why it is done').max(1000),
});

export const closePeriodSchema = z.object({
  note: optText(1000),
  /** A new closing password (needed when none is set yet). */
  closingPassword: z.string().max(128).optional(),
  /** The current closing password (needed to move an existing closing date). */
  currentClosingPassword: z.string().max(128).optional(),
});
export type ClosePeriodInput = z.input<typeof closePeriodSchema>;
