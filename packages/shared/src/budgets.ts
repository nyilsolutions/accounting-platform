import { z } from 'zod';
import { isIsoDate } from './dates';
import { MAX_AMOUNT, parseMoney } from './money';

export const BUDGET_DIMENSIONS = ['none', 'class', 'location', 'customer'] as const;
export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number];
export const BUDGET_DIMENSION_LABELS: Record<BudgetDimension, string> = {
  none: 'Accounts only',
  class: 'Accounts by class',
  location: 'Accounts by location',
  customer: 'Accounts by customer',
};

const firstOfMonth = z
  .string()
  .refine((v) => isIsoDate(v) && v.endsWith('-01'), 'Choose the first day of a month');

export const budgetInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(100),
  startDate: firstOfMonth,
  dimension: z.enum(BUDGET_DIMENSIONS).default('none'),
});
export type BudgetInput = z.input<typeof budgetInputSchema>;

export const budgetRenameSchema = z.object({ name: z.string().trim().min(1).max(100) });

const monthAmount = z
  .string()
  .trim()
  .regex(/^-?\d{1,15}(\.\d{1,2})?$/, 'Enter an amount in dollars and cents')
  .refine((v) => {
    const m = parseMoney(v);
    return (m < 0n ? -m : m) <= MAX_AMOUNT;
  }, 'The amount is too large')
  .nullable();

export const budgetRowSchema = z.object({
  accountId: z.uuid(),
  /** The class, location or customer (per the budget's dimension); null = not specified. */
  dimensionId: z.uuid().nullable().default(null),
  /** Twelve months from the budget's start; null or empty = no budget that month. */
  amounts: z.array(monthAmount).length(12),
});
export type BudgetRow = z.input<typeof budgetRowSchema>;

/** Replaces every amount in the budget. */
export const budgetAmountsInputSchema = z.object({
  rows: z.array(budgetRowSchema).max(5000),
});
export type BudgetAmountsInput = z.input<typeof budgetAmountsInputSchema>;

export interface BudgetSummaryDto {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  dimension: BudgetDimension;
  /** Budgeted income less budgeted expense over the twelve months. */
  netIncome: string;
  updatedAt: string;
}

export interface BudgetRowDto {
  accountId: string;
  dimensionId: string | null;
  amounts: Array<string | null>;
  total: string;
}

export interface BudgetDto extends BudgetSummaryDto {
  /** First day of each of the twelve months. */
  months: string[];
  rows: BudgetRowDto[];
}

/** Actual monthly activity for pre-filling a budget (e.g. last year's numbers). */
export const budgetActualsQuerySchema = z.object({
  startDate: firstOfMonth,
});
