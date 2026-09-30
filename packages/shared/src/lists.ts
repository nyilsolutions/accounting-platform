import { z } from 'zod';
import { decimalPlaces, parseMoney, tryParseMoney } from './money';
import { US_STATES } from './company';
import { isIsoDate } from './dates';
import { EXEMPTION_REASONS, type ExemptionReason } from './sales-tax';

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

const listName = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(max)
    .refine((v) => !v.includes(':'), 'Names cannot contain ":"');

const optEmail = z
  .email()
  .nullable()
  .optional()
  .or(z.literal('').transform(() => null));
const optState = z
  .enum(US_STATES)
  .nullable()
  .optional()
  .or(z.literal('').transform(() => null));
const optZip = z
  .string()
  .trim()
  .regex(/^\d{5}(-\d{4})?$/, 'ZIP must be 12345 or 12345-6789')
  .nullable()
  .optional()
  .or(z.literal('').transform(() => null));

const contactFields = {
  companyName: optText(200),
  firstName: optText(100),
  lastName: optText(100),
  email: optEmail,
  phone: optText(40),
  addressLine1: optText(200),
  addressLine2: optText(200),
  city: optText(100),
  state: optState,
  postalCode: optZip,
  termsId: z.uuid().nullable().optional(),
  notes: optText(4000),
};

// ---- Customers --------------------------------------------------------------------------------
export const customerInputSchema = z.object({
  displayName: listName(200),
  parentId: z.uuid().nullable().optional(),
  taxExempt: z.boolean().optional(),
  /** Sales tax rate new invoices for this customer start with. */
  taxRateId: z.uuid().nullable().optional(),
  taxExemptionReason: z.enum(EXEMPTION_REASONS).nullable().optional(),
  taxExemptionNumber: optText(50),
  ...contactFields,
});
export type CustomerInput = z.input<typeof customerInputSchema>;
export const customerUpdateSchema = customerInputSchema
  .partial()
  .extend({ isActive: z.boolean().optional() });

interface ContactDto {
  companyName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  termsId: string | null;
  notes: string | null;
  isActive: boolean;
}

export interface CustomerDto extends ContactDto {
  id: string;
  displayName: string;
  fullName: string;
  parentId: string | null;
  depth: number;
  taxExempt: boolean;
  taxRateId: string | null;
  taxExemptionReason: ExemptionReason | null;
  taxExemptionNumber: string | null;
}

// ---- Vendors ----------------------------------------------------------------------------------
export const tinSchema = z
  .string()
  .trim()
  .regex(
    /^\d{2}-?\d{7}$|^\d{3}-?\d{2}-?\d{4}$/,
    'Enter a 9-digit EIN (NN-NNNNNNN) or SSN (NNN-NN-NNNN)',
  )
  .transform((v) => v.replace(/-/g, ''));

export const vendorInputSchema = z.object({
  displayName: listName(200),
  ...contactFields,
  accountNumber: optText(50),
  is1099: z.boolean().optional(),
  tinType: z.enum(['ein', 'ssn']).nullable().optional(),
  /** Write-only. Omit to keep the stored TIN, '' to remove it. */
  tin: tinSchema.optional().or(z.literal('')),
  defaultExpenseAccountId: z.uuid().nullable().optional(),
  /** When the contractor's Form W-9 came in. */
  w9ReceivedOn: z
    .string()
    .refine(isIsoDate, 'Enter a valid date')
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
  /** The IRS told you to backup withhold (B-notice), or the contractor gave no TIN. */
  backupWithholding: z.boolean().optional(),
});
export type VendorInput = z.input<typeof vendorInputSchema>;
export const vendorUpdateSchema = vendorInputSchema
  .partial()
  .extend({ isActive: z.boolean().optional() });

export interface VendorDto extends ContactDto {
  id: string;
  displayName: string;
  accountNumber: string | null;
  is1099: boolean;
  tinType: 'ein' | 'ssn' | null;
  /** Masked, e.g. "***-**-1234" or "**-***1234". */
  tinMasked: string | null;
  defaultExpenseAccountId: string | null;
  w9ReceivedOn: string | null;
  backupWithholding: boolean;
}

export function maskTin(type: string | null, last4: string | null): string | null {
  if (!last4) return null;
  return type === 'ssn' ? `***-**-${last4}` : `**-***${last4}`;
}

// ---- Products and services ------------------------------------------------------------------
export const ITEM_TYPES = [
  'service',
  'non_inventory',
  'other_charge',
  'inventory',
  'assembly',
] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  service: 'Service',
  non_inventory: 'Non-inventory',
  other_charge: 'Other charge',
  inventory: 'Inventory',
  assembly: 'Assembly',
};
/** Items whose quantity on hand is tracked (ADR 0018). */
export const STOCKED_ITEM_TYPES: readonly ItemType[] = ['inventory', 'assembly'];
export const isStocked = (t: string): boolean =>
  (STOCKED_ITEM_TYPES as readonly string[]).includes(t);

const optPrice = z
  .string()
  .trim()
  .transform((v) => v.replace(/[$,\s]/g, ''))
  .refine(
    (v) => v === '' || (tryParseMoney(v) !== null && parseMoney(v) >= 0n),
    'Enter a valid, non-negative amount',
  )
  .refine((v) => v === '' || decimalPlaces(v) <= 4, 'At most 4 decimal places')
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();

const positiveQty = z
  .string()
  .trim()
  .refine((v) => tryParseMoney(v) !== null && parseMoney(v) > 0n, 'Enter a quantity above zero')
  .refine((v) => decimalPlaces(v) <= 4, 'At most 4 decimal places');

/** An assembly's parts: each component item and how many go into one assembly. */
export const assemblyComponentsSchema = z
  .array(z.object({ componentId: z.uuid(), quantity: positiveQty }))
  .max(200, 'At most 200 components')
  .refine(
    (v) => new Set(v.map((c) => c.componentId)).size === v.length,
    'List each component once',
  );

const itemFields = {
  sku: optText(100),
  description: optText(4000),
  salesPrice: optPrice,
  incomeAccountId: z.uuid().nullable().optional(),
  purchaseDescription: optText(4000),
  cost: optPrice,
  expenseAccountId: z.uuid().nullable().optional(),
  taxable: z.boolean().optional(),
  /** Inventory and assemblies: the inventory asset account (default: Inventory Asset). */
  assetAccountId: z.uuid().nullable().optional(),
  /** Inventory and assemblies: reorder when the quantity on hand falls to this. */
  reorderPoint: optPrice,
  /** Assemblies only. */
  components: assemblyComponentsSchema.optional(),
};

export const itemInputSchema = z
  .object({ name: listName(100), itemType: z.enum(ITEM_TYPES), ...itemFields })
  .refine((v) => isStocked(v.itemType) || v.incomeAccountId || v.expenseAccountId, {
    message: 'Choose an income account (if you sell it) or an expense account (if you buy it)',
    path: ['incomeAccountId'],
  })
  .refine((v) => v.itemType !== 'assembly' || (v.components?.length ?? 0) > 0, {
    message: 'Add the components that make up the assembly',
    path: ['components'],
  })
  .refine((v) => v.itemType === 'assembly' || !v.components?.length, {
    message: 'Only assemblies have components',
    path: ['components'],
  })
  .refine((v) => isStocked(v.itemType) || (!v.assetAccountId && v.reorderPoint == null), {
    message: 'Only inventory items and assemblies have an asset account and reorder point',
    path: ['assetAccountId'],
  });
export type ItemInput = z.input<typeof itemInputSchema>;
export const itemUpdateSchema = z.object({
  name: listName(100).optional(),
  itemType: z.enum(ITEM_TYPES).optional(),
  ...itemFields,
  isActive: z.boolean().optional(),
});

export interface ItemDto {
  id: string;
  name: string;
  sku: string | null;
  itemType: ItemType;
  description: string | null;
  salesPrice: string | null;
  incomeAccountId: string | null;
  purchaseDescription: string | null;
  cost: string | null;
  expenseAccountId: string | null;
  taxable: boolean;
  isActive: boolean;
  /** Inventory and assemblies (null for other items). */
  assetAccountId: string | null;
  reorderPoint: string | null;
  /** Items converted to inventory: tracked from this date (earlier documents have no quantities). */
  inventoryStartDate: string | null;
  quantityOnHand: string | null;
  /** The value of the quantity on hand, at cost. */
  inventoryValue: string | null;
  /** Assemblies: their components (empty for other items). */
  components: Array<{ componentId: string; name: string; quantity: string }>;
}

// ---- Classes, locations, payment methods, terms -------------------------------------------
export const SIMPLE_LISTS = ['classes', 'locations', 'payment-methods'] as const;
export type SimpleList = (typeof SIMPLE_LISTS)[number];

export const simpleListInputSchema = z.object({
  name: listName(100),
  parentId: z.uuid().nullable().optional(),
});
export const simpleListUpdateSchema = simpleListInputSchema
  .partial()
  .extend({ isActive: z.boolean().optional() });

export interface SimpleListItemDto {
  id: string;
  name: string;
  fullName: string;
  parentId: string | null;
  depth: number;
  isActive: boolean;
}

export const termInputSchema = z.object({
  name: listName(100),
  dueDays: z.number().int().min(0).max(999),
  discountPercent: z
    .string()
    .trim()
    .regex(/^\d{1,3}(\.\d{1,4})?$/, 'Enter a percentage like 2 or 1.5')
    .refine((v) => Number(v) <= 100, 'At most 100%')
    .default('0'),
  discountDays: z.number().int().min(0).max(999).default(0),
});
export const termUpdateSchema = z.object({
  name: listName(100).optional(),
  dueDays: z.number().int().min(0).max(999).optional(),
  discountPercent: z
    .string()
    .trim()
    .regex(/^\d{1,3}(\.\d{1,4})?$/)
    .optional(),
  discountDays: z.number().int().min(0).max(999).optional(),
  isActive: z.boolean().optional(),
});

export interface TermDto {
  id: string;
  name: string;
  dueDays: number;
  discountPercent: string;
  discountDays: number;
  isActive: boolean;
}

export const listQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  includeInactive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;
