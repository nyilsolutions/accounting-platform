import { z } from 'zod';
import { isoDate, optText } from './fields';
import { decimalPlaces, parseMoney, tryParseMoney } from './money';

/** Quantities: up to 4 decimal places. */
const QTY = /^-?\d{1,15}(\.\d{1,4})?$/;
const qty = (message: string, test: (v: bigint) => boolean) =>
  z
    .string()
    .trim()
    .transform((v) => v.replace(/[,\s]/g, ''))
    .refine((v) => QTY.test(v), 'Enter a quantity (up to 4 decimal places)')
    .refine((v) => !QTY.test(v) || test(parseMoney(v)), message);

const unitCost = z
  .string()
  .trim()
  .transform((v) => v.replace(/[$,\s]/g, ''))
  .refine(
    (v) => v === '' || (tryParseMoney(v) !== null && parseMoney(v) >= 0n),
    'Enter a valid cost',
  )
  .refine((v) => v === '' || decimalPlaces(v) <= 4, 'At most 4 decimal places')
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();

export const COSTING_METHODS = ['fifo', 'average'] as const;
export type CostingMethod = (typeof COSTING_METHODS)[number];
export const COSTING_METHOD_LABELS: Record<CostingMethod, string> = {
  fifo: 'FIFO (first in, first out)',
  average: 'Average cost',
};

// ---- Quantity adjustments -------------------------------------------------------------------

export const inventoryAdjustmentLineSchema = z
  .object({
    itemId: z.uuid(),
    /** Positive adds stock, negative removes it. */
    quantityChange: qty('The change cannot be zero', (v) => v !== 0n),
    /** Increases only: the cost of each unit added; empty uses the item's current cost. */
    unitCost,
    /** The account the value goes to or comes from; defaults to the adjustment's account. */
    accountId: z.uuid().nullable().optional(),
    description: optText(4000),
    classId: z.uuid().nullable().optional(),
  })
  .refine((l) => !l.unitCost || !l.quantityChange.startsWith('-'), {
    message: 'A cost can only be given for quantity added',
    path: ['unitCost'],
  });

export const inventoryAdjustmentInputSchema = z.object({
  txnDate: isoDate,
  number: optText(30),
  memo: optText(4000),
  /** Where the value of the change goes (Inventory Shrinkage, Opening Balance Equity…). */
  accountId: z.uuid(),
  lines: z.array(inventoryAdjustmentLineSchema).min(1, 'Add at least one item').max(1000),
  closingPassword: z.string().max(128).optional(),
  version: z.number().int().min(1).optional(),
});
export type InventoryAdjustmentInput = z.input<typeof inventoryAdjustmentInputSchema>;

export interface InventoryAdjustmentDto {
  id: string;
  number: string | null;
  txnDate: string;
  memo: string | null;
  accountId: string;
  lines: Array<{
    lineNo: number;
    itemId: string;
    itemName: string;
    quantityChange: string;
    unitCost: string | null;
    accountId: string;
    description: string | null;
    classId: string | null;
    /** The value added (positive) or removed (negative), at cost. */
    value: string;
  }>;
  /** Total value added (negative when removed). */
  total: string;
  status: 'posted' | 'void';
  version: number;
}

// ---- Assembly builds ------------------------------------------------------------------------

export const inventoryBuildInputSchema = z.object({
  txnDate: isoDate,
  number: optText(30),
  memo: optText(4000),
  assemblyId: z.uuid(),
  quantity: qty('Build at least a part of one', (v) => v > 0n),
  closingPassword: z.string().max(128).optional(),
  version: z.number().int().min(1).optional(),
});
export type InventoryBuildInput = z.input<typeof inventoryBuildInputSchema>;

export interface InventoryBuildDto {
  id: string;
  number: string | null;
  txnDate: string;
  memo: string | null;
  assemblyId: string;
  assemblyName: string;
  quantity: string;
  /** What the components cost: the assemblies' value. */
  cost: string;
  components: Array<{ itemId: string; name: string; quantity: string; cost: string }>;
  status: 'posted' | 'void';
  version: number;
}

// ---- Starting to track inventory (converting items, e.g. after a QuickBooks import) --------

const money2 = z
  .string()
  .trim()
  .transform((v) => v.replace(/[$,\s]/g, ''))
  .refine((v) => tryParseMoney(v) !== null && parseMoney(v) >= 0n, 'Enter a value of zero or more')
  .refine((v) => decimalPlaces(v) <= 2, 'Amounts can have at most 2 decimal places');

export const startTrackingInputSchema = z.object({
  /** The cut-over date: quantities are tracked from this date on. */
  startDate: isoDate,
  /**
   * Where the starting value comes from: null when it is already in the books (QuickBooks'
   * Inventory Asset balance came over with the import), else the account to post it against
   * (such as Opening Balance Equity).
   */
  offsetAccountId: z.uuid().nullable(),
  memo: optText(4000),
  lines: z
    .array(
      z.object({
        itemId: z.uuid(),
        quantity: qty('Enter the quantity on hand (above zero)', (v) => v > 0n),
        /** Total value of that quantity on the start date. */
        value: money2,
        /** Defaults to Inventory Asset. */
        assetAccountId: z.uuid().nullable().optional(),
        /** Defaults to the item's cost of goods sold account, else Cost of Goods Sold. */
        cogsAccountId: z.uuid().nullable().optional(),
      }),
    )
    .min(1, 'Choose at least one item')
    .max(1000)
    .refine((v) => new Set(v.map((l) => l.itemId)).size === v.length, 'List each item once'),
  closingPassword: z.string().max(128).optional(),
});
export type StartTrackingInput = z.input<typeof startTrackingInputSchema>;

export interface InventoryOpeningDto {
  id: string;
  txnDate: string;
  memo: string | null;
  offsetAccountId: string | null;
  lines: Array<{ itemId: string; itemName: string; quantity: string; value: string }>;
  total: string;
  status: 'posted' | 'void';
  version: number;
}

export interface InventoryTxnSummaryDto {
  id: string;
  txnType: 'inventory_adjustment' | 'inventory_build' | 'inventory_opening';
  number: string | null;
  txnDate: string;
  memo: string | null;
  /** Adjustments: the items; builds: the assembly and quantity. */
  summary: string;
  value: string;
  status: 'posted' | 'void';
}
