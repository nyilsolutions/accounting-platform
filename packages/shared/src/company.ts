import { z } from 'zod';

export const US_STATES = [
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'DC',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
  'PR',
  'GU',
  'VI',
  'AS',
  'MP',
] as const;

export const TAX_FORMS = [
  'schedule_c',
  'form_1065',
  'form_1120',
  'form_1120s',
  'form_990',
  'other',
] as const;
export type TaxForm = (typeof TAX_FORMS)[number];

export const TAX_FORM_LABELS: Record<TaxForm, string> = {
  schedule_c: 'Sole proprietor / single-member LLC (Schedule C)',
  form_1065: 'Partnership / multi-member LLC (Form 1065)',
  form_1120: 'C corporation (Form 1120)',
  form_1120s: 'S corporation (Form 1120-S)',
  form_990: 'Nonprofit (Form 990)',
  other: 'Other / not sure',
};

export const ACCOUNTING_BASES = ['accrual', 'cash'] as const;
export type AccountingBasis = (typeof ACCOUNTING_BASES)[number];

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

/** EIN accepted as 9 digits with or without the dash; normalized to NN-NNNNNNN. */
export const einSchema = z
  .string()
  .trim()
  .regex(/^\d{2}-?\d{7}$/, 'EIN must be 9 digits (NN-NNNNNNN)')
  .transform((v) => {
    const digits = v.replace('-', '');
    return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  });

/** Field rules shared by create and update. No defaults here, so PATCH never resets omitted fields. */
const companyFields = z.object({
  legalName: z.string().trim().min(1, 'Legal name is required').max(200),
  dbaName: optionalText(200),
  ein: einSchema
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(100),
  state: z.enum(US_STATES).nullable().optional(),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{5}(-\d{4})?$/, 'ZIP must be 12345 or 12345-6789')
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
  phone: optionalText(40),
  email: z
    .email()
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
  fiscalYearStartMonth: z.number().int().min(1).max(12),
  taxForm: z.enum(TAX_FORMS),
  accountingBasis: z.enum(ACCOUNTING_BASES),
});

export const companyInputSchema = companyFields.extend({
  fiscalYearStartMonth: companyFields.shape.fiscalYearStartMonth.default(1),
  taxForm: companyFields.shape.taxForm.default('schedule_c'),
  accountingBasis: companyFields.shape.accountingBasis.default('accrual'),
});

export type CompanyInput = z.input<typeof companyInputSchema>;

export const companyUpdateSchema = companyFields.partial();
export type CompanyUpdate = z.input<typeof companyUpdateSchema>;

export interface CompanyDto {
  id: string;
  legalName: string;
  dbaName: string | null;
  /** Always masked (e.g. "**-***4567") unless explicitly revealed. */
  einMasked: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  phone: string | null;
  email: string | null;
  fiscalYearStartMonth: number;
  taxForm: TaxForm;
  accountingBasis: AccountingBasis;
  createdAt: string;
  updatedAt: string;
}

export interface CompanySummaryDto {
  id: string;
  legalName: string;
  dbaName: string | null;
  role: import('./permissions').Role;
}

export function maskEin(last4: string | null): string | null {
  return last4 ? `**-***${last4}` : null;
}
