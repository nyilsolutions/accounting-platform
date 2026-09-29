import { z } from 'zod';
import { isIsoDate } from './dates';
import { MAX_AMOUNT, parseMoney, type Money } from './money';

// ---------------------------------------------------------------------------------------------
// Agencies and rates
// ---------------------------------------------------------------------------------------------
export const FILING_FREQUENCIES = ['monthly', 'quarterly', 'annually'] as const;
export type FilingFrequency = (typeof FILING_FREQUENCIES)[number];
export const FILING_FREQUENCY_LABELS: Record<FilingFrequency, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annually: 'Annually',
};

export const EXEMPTION_REASONS = [
  'resale',
  'government',
  'nonprofit',
  'agriculture',
  'manufacturing',
  'other',
] as const;
export type ExemptionReason = (typeof EXEMPTION_REASONS)[number];
export const EXEMPTION_REASON_LABELS: Record<ExemptionReason, string> = {
  resale: 'Resale',
  government: 'Government',
  nonprofit: 'Nonprofit organization',
  agriculture: 'Agriculture',
  manufacturing: 'Manufacturing',
  other: 'Other',
};

const isoDate = z.string().refine(isIsoDate, 'Enter a valid date');
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

/** A percentage with up to 6 decimals, 0 to 100 ("8.875"). */
export const percentSchema = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,6})?$/, 'Enter a percentage such as 8.25')
  .refine((v) => Number(v.split('.')[0]) <= 100 && parsePercent(v) <= 100_000_000n, {
    message: 'A rate cannot be more than 100%',
  });

export const taxAgencyInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(100),
  registrationNumber: optText(50),
  filingFrequency: z.enum(FILING_FREQUENCIES).default('quarterly'),
  isActive: z.boolean().optional(),
});
export type TaxAgencyInput = z.input<typeof taxAgencyInputSchema>;

export const taxRateInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter a name').max(100),
    description: optText(200),
    kind: z.enum(['single', 'combined']),
    /** Single rates: the agency it is owed to. */
    agencyId: z.uuid().nullable().optional(),
    /** Single rates: the percentage, from `effectiveFrom` (creating) on. */
    rate: percentSchema.optional(),
    effectiveFrom: isoDate.optional(),
    /** Combined rates: two or more single rates. */
    componentIds: z.array(z.uuid()).max(10).optional(),
    isActive: z.boolean().optional(),
  })
  .superRefine((r, ctx) => {
    if (r.kind === 'single' && !r.agencyId)
      ctx.addIssue({ code: 'custom', path: ['agencyId'], message: 'Choose the agency' });
    if (r.kind === 'combined') {
      const ids = r.componentIds ?? [];
      if (ids.length < 2)
        ctx.addIssue({
          code: 'custom',
          path: ['componentIds'],
          message: 'Choose at least two rates to combine',
        });
      if (new Set(ids).size !== ids.length)
        ctx.addIssue({ code: 'custom', path: ['componentIds'], message: 'A rate is listed twice' });
    }
  });
export type TaxRateInput = z.input<typeof taxRateInputSchema>;

/** A single rate's new percentage from a date (old documents keep the rate they were charged). */
export const taxRateValueInputSchema = z.object({
  effectiveFrom: isoDate,
  rate: percentSchema,
});
export type TaxRateValueInput = z.input<typeof taxRateValueInputSchema>;

export interface TaxAgencyDto {
  id: string;
  name: string;
  registrationNumber: string | null;
  filingFrequency: FilingFrequency;
  isActive: boolean;
}

export interface TaxRateComponentDto {
  id: string;
  name: string;
  agencyId: string;
  agencyName: string;
  /** Percentage in effect on the day asked for (today by default). */
  rate: string;
}

export interface TaxRateDto {
  id: string;
  name: string;
  description: string | null;
  kind: 'single' | 'combined';
  agencyId: string | null;
  agencyName: string | null;
  isActive: boolean;
  /** Total percentage in effect on the day asked for. */
  rate: string;
  /** Single rates: the percentage history, oldest first. */
  values: Array<{ effectiveFrom: string; rate: string }>;
  /** What the rate is made of: itself for a single rate, its components for a combined rate. */
  components: TaxRateComponentDto[];
}

// ---------------------------------------------------------------------------------------------
// Paying and adjusting
// ---------------------------------------------------------------------------------------------
const positiveAmount = z
  .string()
  .trim()
  .regex(/^\d{1,15}(\.\d{1,2})?$/, 'Enter an amount in dollars and cents')
  .refine((v) => parseMoney(v) > 0n, 'The amount must be greater than zero')
  .refine((v) => parseMoney(v) <= MAX_AMOUNT, 'The amount is too large');

export const salesTaxPaymentInputSchema = z.object({
  agencyId: z.uuid(),
  txnDate: isoDate,
  /** Bank (or credit card) account the payment comes from. */
  paymentAccountId: z.uuid(),
  amount: positiveAmount,
  number: optText(30),
  memo: optText(4000),
  closingPassword: z.string().max(128).optional(),
  version: z.number().int().min(1).optional(),
});
export type SalesTaxPaymentInput = z.input<typeof salesTaxPaymentInputSchema>;

export const salesTaxAdjustmentInputSchema = z.object({
  agencyId: z.uuid(),
  txnDate: isoDate,
  /** Decrease: a discount or credit from the agency. Increase: tax owed that wasn't charged. */
  direction: z.enum(['increase', 'decrease']),
  amount: positiveAmount,
  /** The other side: an income account for a decrease, an expense account for an increase. */
  accountId: z.uuid(),
  memo: optText(4000),
  closingPassword: z.string().max(128).optional(),
  version: z.number().int().min(1).optional(),
});
export type SalesTaxAdjustmentInput = z.input<typeof salesTaxAdjustmentInputSchema>;

export interface SalesTaxAgencySummaryDto {
  agencyId: string;
  name: string;
  filingFrequency: FilingFrequency;
  registrationNumber: string | null;
  isActive: boolean;
  /** The filing period containing the date asked for, and the one before it. */
  period: { from: string; to: string };
  previousPeriod: { from: string; to: string };
  /** Owed as of the end of the previous period (what the next return usually pays). */
  dueForPreviousPeriod: string;
  /** Owed as of the date asked for. */
  balance: string;
  lastPayment: { id: string; txnDate: string; amount: string } | null;
}

export interface SalesTaxActivityDto {
  id: string;
  txnType: 'sales_tax_payment' | 'sales_tax_adjustment';
  txnDate: string;
  number: string | null;
  agencyId: string;
  agencyName: string;
  /** Payment: paid. Adjustment: + increases, - decreases what is owed. */
  amount: string;
  memo: string | null;
  status: 'posted' | 'void';
  accountName: string | null;
}

export interface SalesTaxPaymentDto extends SalesTaxActivityDto {
  paymentAccountId: string | null;
  accountId: string | null;
  version: number;
}

// ---------------------------------------------------------------------------------------------
// Calculation (the web previews it; the API recomputes and never trusts the browser's amounts)
// ---------------------------------------------------------------------------------------------

/** Parses a percentage string to millionths of a percent (8.875 → 8_875_000n). */
export function parsePercent(v: string): bigint {
  const [whole, frac = ''] = v.trim().split('.');
  return BigInt(whole || '0') * 1_000_000n + BigInt(frac.padEnd(6, '0').slice(0, 6));
}

export function percentToString(v: bigint): string {
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Tax on `amount` at `percent` (a percentage string), rounded half away from zero to the cent. */
export function taxOn(amount: Money, percent: string): Money {
  const exact = amount * parsePercent(percent); // in 1/10,000 × 1/100,000,000 of a percent
  const den = 100n * 1_000_000n * 100n; // percent, millionths, then whole cents (100 units)
  const abs = exact < 0n ? -exact : exact;
  const cents = (abs + den / 2n) / den;
  return (exact < 0n ? -cents : cents) * 100n;
}

export interface TaxComponent {
  rateId: string;
  agencyId: string;
  /** Percentage in effect on the document date. */
  rate: string;
}

export interface SalesTaxResult {
  /** Sum of taxable lines (after discounts on taxable lines). */
  taxable: Money;
  /** Sum of the other lines, and of every line when the customer is exempt. */
  nonTaxable: Money;
  components: Array<TaxComponent & { taxable: Money; amount: Money }>;
  total: Money;
}

/**
 * The tax on a sales document: each component's rate on the taxable total, rounded to the cent
 * (as QuickBooks does for combined rates). An exempt customer is charged nothing. An override
 * total (the amount on a paper invoice being entered) is split across the components in
 * proportion to their rates, the remainder going to the largest.
 */
export function computeSalesTax(
  lines: Array<{ amount: Money; taxable: boolean }>,
  components: TaxComponent[],
  opts: { exempt?: boolean; override?: Money | null } = {},
): SalesTaxResult {
  const all = lines.reduce((s, l) => s + l.amount, 0n);
  const taxable = opts.exempt ? 0n : lines.reduce((s, l) => s + (l.taxable ? l.amount : 0n), 0n);
  const nonTaxable = all - taxable;
  if (components.length === 0 || taxable === 0n) {
    return {
      taxable,
      nonTaxable,
      components: components.map((c) => ({ ...c, taxable, amount: 0n })),
      total: 0n,
    };
  }
  let amounts = components.map((c) => taxOn(taxable, c.rate));
  if (opts.override != null) {
    const weights = components.map((c) => parsePercent(c.rate));
    const weightSum = weights.reduce((s, w) => s + w, 0n);
    const override = opts.override;
    amounts =
      weightSum === 0n
        ? components.map((_, i) => (i === 0 ? override : 0n))
        : weights.map((w) => ((override * w) / weightSum / 100n) * 100n);
    const diff = override - amounts.reduce((s, a) => s + a, 0n);
    let largest = 0;
    weights.forEach((w, i) => {
      if (w > weights[largest]!) largest = i;
    });
    amounts[largest] = amounts[largest]! + diff;
  }
  return {
    taxable,
    nonTaxable,
    components: components.map((c, i) => ({ ...c, taxable, amount: amounts[i]! })),
    total: amounts.reduce((s, a) => s + a, 0n),
  };
}

/** Sum of component percentages, for display ("8.875"). */
export function combinedPercent(components: Array<{ rate: string }>): string {
  return percentToString(components.reduce((s, c) => s + parsePercent(c.rate), 0n));
}
