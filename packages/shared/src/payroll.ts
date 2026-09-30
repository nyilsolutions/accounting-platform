import { z } from 'zod';
import { US_STATES } from './company';
import { addDays, addMonths, isIsoDate, monthEndOf, weekday, type IsoDate } from './dates';
import { decimalPlaces, MAX_AMOUNT, parseMoney, tryParseMoney } from './money';

/**
 * Payroll setup and employees (Phase 8). Nothing in this file is a tax rate, wage base or table:
 * those come from /tax-data/<year>/ (CLAUDE.md rule 7). This is what employers and employees
 * enter: registrations, schedules, certificates, bank accounts.
 */

// ---------------------------------------------------------------------------------------------
// Supported states (docs/states.md)
// ---------------------------------------------------------------------------------------------
export const PAYROLL_STATES = ['CA', 'FL', 'IL', 'NY', 'TX'] as const;
export type PayrollState = (typeof PAYROLL_STATES)[number];
export const PAYROLL_STATE_LABELS: Record<PayrollState, string> = {
  CA: 'California',
  FL: 'Florida',
  IL: 'Illinois',
  NY: 'New York',
  TX: 'Texas',
};
export function isPayrollState(s: string | null | undefined): s is PayrollState {
  return (PAYROLL_STATES as readonly string[]).includes(s ?? '');
}

/** The state withholding certificate, for the supported states that have an income tax. */
export const STATE_CERTIFICATE_FORMS: Record<PayrollState, string | null> = {
  CA: 'DE 4',
  FL: null,
  IL: 'IL-W-4',
  NY: 'IT-2104',
  TX: null,
};

// ---------------------------------------------------------------------------------------------
// Field builders
// ---------------------------------------------------------------------------------------------
const isoDate = z.string().refine(isIsoDate, 'Enter a valid date');
const optDate = z
  .union([z.literal('').transform(() => null), isoDate])
  .nullable()
  .optional();
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();
const reqText = (max: number, message: string) => z.string().trim().min(1, message).max(max);
const optState = z
  .union([z.literal('').transform(() => null), z.enum(US_STATES)])
  .nullable()
  .optional();
const optZip = z
  .union([
    z.literal('').transform(() => null),
    z
      .string()
      .trim()
      .regex(/^\d{5}(-\d{4})?$/, 'ZIP must be 12345 or 12345-6789'),
  ])
  .nullable()
  .optional();

/** Dollars and cents, zero or more. */
const money = z
  .string()
  .trim()
  .transform((v) => v.replace(/[$,\s]/g, ''))
  .refine((v) => tryParseMoney(v) !== null, 'Enter a valid amount')
  .refine((v) => tryParseMoney(v) === null || decimalPlaces(v) <= 2, 'Use at most 2 decimal places')
  .refine((v) => tryParseMoney(v) === null || parseMoney(v) >= 0n, 'Enter a positive amount')
  .refine((v) => tryParseMoney(v) === null || parseMoney(v) <= MAX_AMOUNT, 'Amount is too large');
const moneyOrZero = z
  .union([z.literal('').transform(() => '0'), money])
  .optional()
  .transform((v) => v ?? '0');
const optMoney = z
  .union([z.literal('').transform(() => null), money])
  .nullable()
  .optional();

/** A decimal with limited places and an upper bound (hours, rates, percentages). */
const decimal = (places: number, max: number, message: string) =>
  z
    .string()
    .trim()
    .transform((v) => v.replace(/[,\s%$]/g, ''))
    .superRefine((v, ctx) => {
      if (!new RegExp(`^\\d{1,9}(\\.\\d{1,${places}})?$`).test(v)) {
        ctx.addIssue({ code: 'custom', message });
      } else if (compareDecimal(v, String(max)) > 0) {
        ctx.addIssue({ code: 'custom', message: `Enter at most ${max}` });
      }
    });
const optDecimal = (places: number, max: number, message: string) =>
  z
    .union([z.literal('').transform(() => null), decimal(places, max, message)])
    .nullable()
    .optional();

/** Compares two non-negative decimal strings exactly. */
function compareDecimal(a: string, b: string): number {
  const [ai = '0', af = ''] = a.split('.');
  const [bi = '0', bf = ''] = b.split('.');
  const places = Math.max(af.length, bf.length);
  const x = BigInt(ai + af.padEnd(places, '0'));
  const y = BigInt(bi + bf.padEnd(places, '0'));
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * A Social Security number: 9 digits, not an area of 000, 666 or 9xx, not group 00 or serial
 * 0000 (SSA's rules for numbers it issues). Normalized to 9 digits.
 */
export const ssnSchema = z
  .string()
  .trim()
  .regex(/^\d{3}-?\d{2}-?\d{4}$/, 'Enter a 9-digit SSN (NNN-NN-NNNN)')
  .transform((v) => v.replace(/-/g, ''))
  .refine(
    (v) =>
      !v.startsWith('000') &&
      !v.startsWith('666') &&
      !v.startsWith('9') &&
      v.slice(3, 5) !== '00' &&
      v.slice(5) !== '0000',
    'This is not a valid SSN',
  );

export function maskSsn(last4: string | null): string | null {
  return last4 ? `***-**-${last4}` : null;
}

/** ABA routing number check digit: 3·(d1+d4+d7) + 7·(d2+d5+d8) + (d3+d6+d9) ≡ 0 (mod 10). */
export function isValidRoutingNumber(v: string): boolean {
  if (!/^\d{9}$/.test(v)) return false;
  const d = [...v].map(Number);
  const sum = 3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!);
  return sum % 10 === 0;
}

export const routingNumberSchema = z
  .string()
  .trim()
  .regex(/^\d{9}$/, 'A routing number has 9 digits')
  .refine(isValidRoutingNumber, 'This routing number is not valid (check digit)');

// ---------------------------------------------------------------------------------------------
// Company payroll settings
// ---------------------------------------------------------------------------------------------
export const FEDERAL_FORMS = ['941', '944'] as const;
export type FederalForm = (typeof FEDERAL_FORMS)[number];
export const FEDERAL_FORM_LABELS: Record<FederalForm, string> = {
  '941': 'Form 941 (quarterly)',
  '944': 'Form 944 (annual, only if the IRS notified you)',
};
export const DEPOSIT_SCHEDULES = ['monthly', 'semiweekly'] as const;
export type DepositSchedule = (typeof DEPOSIT_SCHEDULES)[number];
export const DEPOSIT_SCHEDULE_LABELS: Record<DepositSchedule, string> = {
  monthly: 'Monthly depositor',
  semiweekly: 'Semiweekly depositor',
};

export const payrollSettingsInputSchema = z.object({
  federalForm: z.enum(FEDERAL_FORMS).default('941'),
  depositSchedule: z.enum(DEPOSIT_SCHEDULES).default('monthly'),
  payrollStartDate: optDate,
  /** Omitted on first setup: the chart's Payroll Expenses and Payroll Liabilities accounts. */
  wageExpenseAccountId: z.uuid().optional(),
  taxExpenseAccountId: z.uuid().optional(),
  liabilityAccountId: z.uuid().optional(),
  bankAccountId: z.uuid().nullable().optional(),
  achOdfiRouting: z
    .union([z.literal('').transform(() => null), routingNumberSchema])
    .nullable()
    .optional(),
  achOdfiName: optText(23),
  achCompanyName: optText(16),
  achCompanyId: z
    .union([
      z.literal('').transform(() => null),
      z
        .string()
        .trim()
        .regex(/^[0-9A-Za-z ]{10}$/, 'The company ID your bank assigned has 10 characters'),
    ])
    .nullable()
    .optional(),
  /** New York: collect the employee Paid Family Leave contribution (else the company pays it). */
  nyPflDeducted: z.boolean().optional(),
  /** New York: collect the employee disability benefits (DBL) contribution. */
  nyDblDeducted: z.boolean().optional(),
});
export type PayrollSettingsInput = z.input<typeof payrollSettingsInputSchema>;

export interface PayrollSettingsDto {
  federalForm: FederalForm;
  depositSchedule: DepositSchedule;
  payrollStartDate: string | null;
  wageExpenseAccountId: string;
  taxExpenseAccountId: string;
  liabilityAccountId: string;
  bankAccountId: string | null;
  achOdfiRouting: string | null;
  achOdfiName: string | null;
  achCompanyName: string | null;
  achCompanyId: string | null;
  nyPflDeducted: boolean;
  nyDblDeducted: boolean;
  /** Whether the company has an EIN on file (payroll needs one). */
  hasEin: boolean;
}

// ---------------------------------------------------------------------------------------------
// Pay schedules
// ---------------------------------------------------------------------------------------------
export const PAY_FREQUENCIES = ['weekly', 'biweekly', 'semimonthly', 'monthly'] as const;
export type PayFrequency = (typeof PAY_FREQUENCIES)[number];
export const PAY_FREQUENCY_LABELS: Record<PayFrequency, string> = {
  weekly: 'Every week',
  biweekly: 'Every other week',
  semimonthly: 'Twice a month (15th and last day)',
  monthly: 'Every month',
};
/** Pay periods in a year, for annualizing and for spreading an annual salary. */
export const PAY_PERIODS_PER_YEAR: Record<PayFrequency, number> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
};

export const payScheduleInputSchema = z
  .object({
    name: reqText(60, 'Enter a name'),
    frequency: z.enum(PAY_FREQUENCIES),
    firstPeriodEnd: isoDate,
    payDateOffset: z.number().int().min(0).max(30).default(0),
    isActive: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (
      v.frequency === 'semimonthly' &&
      isIsoDate(v.firstPeriodEnd) &&
      !v.firstPeriodEnd.endsWith('-15') &&
      monthEndOf(v.firstPeriodEnd) !== v.firstPeriodEnd
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['firstPeriodEnd'],
        message: 'Twice-a-month periods end on the 15th or the last day of the month',
      });
    }
  });
export type PayScheduleInput = z.input<typeof payScheduleInputSchema>;

export interface PayScheduleDto {
  id: string;
  name: string;
  frequency: PayFrequency;
  firstPeriodEnd: string;
  payDateOffset: number;
  isActive: boolean;
  /** The next few periods from today. */
  upcoming: PayPeriod[];
}

export interface PayPeriod {
  start: IsoDate;
  end: IsoDate;
  payDate: IsoDate;
}

type ScheduleShape = Pick<PayScheduleDto, 'frequency' | 'firstPeriodEnd' | 'payDateOffset'>;

function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** The end of the period that ends on or after `date`. */
function periodEndOnOrAfter(s: ScheduleShape, date: IsoDate): IsoDate {
  switch (s.frequency) {
    case 'weekly':
    case 'biweekly': {
      const step = s.frequency === 'weekly' ? 7 : 14;
      const k = Math.ceil(daysBetween(s.firstPeriodEnd, date) / step);
      return addDays(s.firstPeriodEnd, k * step);
    }
    case 'semimonthly': {
      const mid = `${date.slice(0, 7)}-15`;
      return date <= mid ? mid : monthEndOf(date);
    }
    case 'monthly': {
      const end = monthlyEnd(s.firstPeriodEnd, date);
      return end >= date
        ? end
        : monthlyEnd(s.firstPeriodEnd, addMonths(`${date.slice(0, 7)}-01`, 1));
    }
  }
}

/** The monthly period end in the month of `inMonth`, on the anchor's day (or month end). */
function monthlyEnd(anchor: IsoDate, inMonth: IsoDate): IsoDate {
  if (monthEndOf(anchor) === anchor) return monthEndOf(inMonth);
  return clampDay(inMonth.slice(0, 7), Number(anchor.slice(8)));
}

function clampDay(yearMonth: string, day: number): IsoDate {
  const last = Number(monthEndOf(`${yearMonth}-01`).slice(8));
  return `${yearMonth}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

function previousPeriodEnd(s: ScheduleShape, end: IsoDate): IsoDate {
  switch (s.frequency) {
    case 'weekly':
      return addDays(end, -7);
    case 'biweekly':
      return addDays(end, -14);
    case 'semimonthly':
      return end.endsWith('-15')
        ? monthEndOf(addMonths(`${end.slice(0, 7)}-01`, -1))
        : `${end.slice(0, 7)}-15`;
    case 'monthly':
      return monthlyEnd(s.firstPeriodEnd, addMonths(`${end.slice(0, 7)}-01`, -1));
  }
}

/** A pay date on a weekend moves back to the Friday before. (Bank holidays are not handled.) */
export function payDateFor(periodEnd: IsoDate, offset: number): IsoDate {
  const d = addDays(periodEnd, offset);
  const w = weekday(d);
  return w === 6 ? addDays(d, -1) : w === 0 ? addDays(d, -2) : d;
}

/** `count` consecutive pay periods, the first being the one that ends on or after `from`. */
export function payPeriods(s: ScheduleShape, from: IsoDate, count: number): PayPeriod[] {
  const out: PayPeriod[] = [];
  let end = periodEndOnOrAfter(s, from);
  for (let i = 0; i < count; i++) {
    const start = addDays(previousPeriodEnd(s, end), 1);
    out.push({ start, end, payDate: payDateFor(end, s.payDateOffset) });
    end = periodEndOnOrAfter(s, addDays(end, 1));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// State registrations, unemployment rates, workers' comp classes
// ---------------------------------------------------------------------------------------------
export const STATE_DEPOSIT_SCHEDULES = ['monthly', 'semiweekly'] as const;
export type StateDepositSchedule = (typeof STATE_DEPOSIT_SCHEDULES)[number];
export const stateRegistrationInputSchema = z.object({
  state: z.enum(PAYROLL_STATES, 'Payroll supports CA, FL, IL, NY and TX for now'),
  withholdingAccountNumber: optText(30),
  unemploymentAccountNumber: optText(30),
  /** The withholding deposit schedule the state assigned (Illinois: from its IDOR notice). */
  withholdingDepositSchedule: z.enum(STATE_DEPOSIT_SCHEDULES).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type StateRegistrationInput = z.input<typeof stateRegistrationInputSchema>;

export const unemploymentRateInputSchema = z.object({
  year: z.number().int().min(2000).max(2199),
  /** Percent of taxable wages from the state's rate notice, e.g. 2.7. */
  rate: decimal(4, 25, 'Enter a percentage such as 2.7'),
});
export type UnemploymentRateInput = z.input<typeof unemploymentRateInputSchema>;

export interface StateRegistrationDto {
  id: string;
  state: PayrollState;
  withholdingAccountNumber: string | null;
  unemploymentAccountNumber: string | null;
  withholdingDepositSchedule: StateDepositSchedule | null;
  isActive: boolean;
  /** The employer's unemployment rate per year, newest first. */
  unemploymentRates: { year: number; rate: string }[];
}

export const workersCompClassInputSchema = z.object({
  state: z.enum(PAYROLL_STATES),
  code: reqText(10, 'Enter the class code'),
  description: reqText(100, 'Enter a description'),
  /** Premium per $100 of wages, from the policy. */
  rate: decimal(4, 100, 'Enter the rate per $100 of wages, such as 3.25'),
  isActive: z.boolean().optional(),
});
export type WorkersCompClassInput = z.input<typeof workersCompClassInputSchema>;

export interface WorkersCompClassDto {
  id: string;
  state: PayrollState;
  code: string;
  description: string;
  rate: string;
  isActive: boolean;
}

// ---------------------------------------------------------------------------------------------
// PTO policies
// ---------------------------------------------------------------------------------------------
export const PTO_KINDS = ['vacation', 'sick', 'personal', 'other'] as const;
export type PtoKind = (typeof PTO_KINDS)[number];
export const PTO_KIND_LABELS: Record<PtoKind, string> = {
  vacation: 'Vacation',
  sick: 'Sick',
  personal: 'Personal',
  other: 'Other',
};
export const PTO_ACCRUAL_METHODS = ['none', 'per_hour_worked', 'per_pay_period', 'annual'] as const;
export type PtoAccrualMethod = (typeof PTO_ACCRUAL_METHODS)[number];
export const PTO_ACCRUAL_LABELS: Record<PtoAccrualMethod, string> = {
  none: 'No accrual (adjusted by hand)',
  per_hour_worked: 'Hours per hour worked',
  per_pay_period: 'Hours per paycheck',
  annual: 'Hours at the start of each year',
};

export const ptoPolicyInputSchema = z
  .object({
    name: reqText(60, 'Enter a name'),
    kind: z.enum(PTO_KINDS),
    accrualMethod: z.enum(PTO_ACCRUAL_METHODS),
    accrualRate: decimal(4, 9999, 'Enter hours, such as 0.0385 or 4').default('0'),
    maxBalance: optDecimal(2, 9999999, 'Enter hours, such as 80'),
    carryoverLimit: optDecimal(2, 9999999, 'Enter hours, such as 40'),
    isActive: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.accrualMethod !== 'none' && compareDecimal(v.accrualRate, '0') === 0) {
      ctx.addIssue({ code: 'custom', path: ['accrualRate'], message: 'Enter the hours accrued' });
    }
  });
export type PtoPolicyInput = z.input<typeof ptoPolicyInputSchema>;

export interface PtoPolicyDto {
  id: string;
  name: string;
  kind: PtoKind;
  accrualMethod: PtoAccrualMethod;
  accrualRate: string;
  maxBalance: string | null;
  carryoverLimit: string | null;
  isActive: boolean;
}

// ---------------------------------------------------------------------------------------------
// Payroll items
// ---------------------------------------------------------------------------------------------
export const PAYROLL_ITEM_CATEGORIES = [
  'earning',
  'pre_tax_deduction',
  'post_tax_deduction',
  'employer_contribution',
] as const;
export type PayrollItemCategory = (typeof PAYROLL_ITEM_CATEGORIES)[number];
export const PAYROLL_ITEM_CATEGORY_LABELS: Record<PayrollItemCategory, string> = {
  earning: 'Earnings',
  pre_tax_deduction: 'Pre-tax deductions',
  post_tax_deduction: 'After-tax deductions',
  employer_contribution: 'Company contributions',
};

/**
 * Item kinds and what they are. How each kind is taxed (federal income tax, FICA, FUTA, state)
 * is tax law and comes from the year's tax data, not from here.
 */
export const PAYROLL_ITEM_KINDS = {
  hourly: { category: 'earning', label: 'Hourly wage' },
  overtime: { category: 'earning', label: 'Overtime' },
  double_time: { category: 'earning', label: 'Double time' },
  salary: { category: 'earning', label: 'Salary' },
  bonus: { category: 'earning', label: 'Bonus' },
  commission: { category: 'earning', label: 'Commission' },
  cash_tips: { category: 'earning', label: 'Cash tips (reported by the employee)' },
  paid_tips: { category: 'earning', label: 'Tips paid through payroll (card tips)' },
  vacation: { category: 'earning', label: 'Vacation pay' },
  sick: { category: 'earning', label: 'Sick pay' },
  holiday: { category: 'earning', label: 'Holiday pay' },
  reimbursement: { category: 'earning', label: 'Expense reimbursement' },
  fringe_benefit: { category: 'earning', label: 'Taxable fringe benefit' },
  other_earning: { category: 'earning', label: 'Other earnings' },
  traditional_401k: { category: 'pre_tax_deduction', label: '401(k)' },
  traditional_403b: { category: 'pre_tax_deduction', label: '403(b)' },
  section_125: { category: 'pre_tax_deduction', label: 'Section 125 (cafeteria plan) health' },
  hsa: { category: 'pre_tax_deduction', label: 'HSA (through a cafeteria plan)' },
  health_fsa: { category: 'pre_tax_deduction', label: 'Health FSA' },
  dependent_care_fsa: { category: 'pre_tax_deduction', label: 'Dependent care FSA' },
  roth_401k: { category: 'post_tax_deduction', label: 'Roth 401(k)' },
  roth_403b: { category: 'post_tax_deduction', label: 'Roth 403(b)' },
  garnishment: { category: 'post_tax_deduction', label: 'Garnishment' },
  loan_repayment: { category: 'post_tax_deduction', label: 'Loan repayment' },
  other_deduction: { category: 'post_tax_deduction', label: 'Other after-tax deduction' },
  retirement_match: { category: 'employer_contribution', label: 'Retirement plan match' },
  employer_health: { category: 'employer_contribution', label: 'Health insurance (company paid)' },
  employer_hsa: {
    category: 'employer_contribution',
    label: 'HSA (company contribution outside a cafeteria plan)',
  },
  employer_hsa_cafeteria: {
    category: 'employer_contribution',
    label: 'HSA (company contribution through the cafeteria plan)',
  },
  other_employer_contribution: {
    category: 'employer_contribution',
    label: 'Other company contribution',
  },
} as const satisfies Record<string, { category: PayrollItemCategory; label: string }>;
export type PayrollItemKind = keyof typeof PAYROLL_ITEM_KINDS;
export const PAYROLL_ITEM_KIND_LIST = Object.keys(PAYROLL_ITEM_KINDS) as PayrollItemKind[];
export function payrollItemCategory(kind: PayrollItemKind): PayrollItemCategory {
  return PAYROLL_ITEM_KINDS[kind].category;
}
const PTO_ITEM_KINDS: PayrollItemKind[] = ['vacation', 'sick', 'holiday', 'other_earning'];
const MULTIPLIER_KINDS: PayrollItemKind[] = ['overtime', 'double_time'];

export const GARNISHMENT_TYPES = [
  'child_support',
  'creditor',
  'federal_tax_levy',
  'state_tax_levy',
  'student_loan',
  'bankruptcy',
  'other',
] as const;
export type GarnishmentType = (typeof GARNISHMENT_TYPES)[number];
export const GARNISHMENT_TYPE_LABELS: Record<GarnishmentType, string> = {
  child_support: 'Child or spousal support',
  creditor: 'Creditor garnishment',
  federal_tax_levy: 'Federal tax levy',
  state_tax_levy: 'State tax levy',
  student_loan: 'Federal student loan',
  bankruptcy: 'Bankruptcy order',
  other: 'Other',
};

export const payrollItemInputSchema = z
  .object({
    name: reqText(60, 'Enter a name'),
    kind: z.enum(PAYROLL_ITEM_KIND_LIST as [PayrollItemKind, ...PayrollItemKind[]]),
    rateMultiplier: optDecimal(4, 10, 'Enter a multiple such as 1.5'),
    ptoPolicyId: z.uuid().nullable().optional(),
    garnishmentType: z.enum(GARNISHMENT_TYPES).nullable().optional(),
    expenseAccountId: z.uuid().nullable().optional(),
    liabilityAccountId: z.uuid().nullable().optional(),
    vendorId: z.uuid().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    const multiplier = MULTIPLIER_KINDS.includes(v.kind);
    if (multiplier && !v.rateMultiplier) {
      ctx.addIssue({
        code: 'custom',
        path: ['rateMultiplier'],
        message: 'Enter the multiple of the regular rate',
      });
    }
    if (!multiplier && v.rateMultiplier) {
      ctx.addIssue({
        code: 'custom',
        path: ['rateMultiplier'],
        message: 'Only overtime and double time have a multiple',
      });
    }
    if (v.ptoPolicyId && !PTO_ITEM_KINDS.includes(v.kind)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ptoPolicyId'],
        message: 'Only paid time off items draw from a PTO policy',
      });
    }
    if ((v.kind === 'garnishment') !== !!v.garnishmentType) {
      ctx.addIssue({
        code: 'custom',
        path: ['garnishmentType'],
        message:
          v.kind === 'garnishment'
            ? 'Choose the kind of garnishment'
            : 'Only garnishments have a garnishment type',
      });
    }
  });
export type PayrollItemInput = z.input<typeof payrollItemInputSchema>;

export interface PayrollItemDto {
  id: string;
  name: string;
  kind: PayrollItemKind;
  category: PayrollItemCategory;
  rateMultiplier: string | null;
  ptoPolicyId: string | null;
  garnishmentType: GarnishmentType | null;
  expenseAccountId: string | null;
  liabilityAccountId: string | null;
  vendorId: string | null;
  isActive: boolean;
}

// ---------------------------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------------------------
export const PAY_TYPES = ['hourly', 'salary', 'commission'] as const;
export type PayType = (typeof PAY_TYPES)[number];
export const PAY_TYPE_LABELS: Record<PayType, string> = {
  hourly: 'Hourly',
  salary: 'Salary',
  commission: 'Commission only',
};
export const PAY_METHODS = ['check', 'direct_deposit'] as const;
export type PayMethod = (typeof PAY_METHODS)[number];
export const PAY_METHOD_LABELS: Record<PayMethod, string> = {
  check: 'Paper check',
  direct_deposit: 'Direct deposit',
};

export const employeeInputSchema = z
  .object({
    employeeNumber: optText(20),
    firstName: reqText(50, 'Enter a first name'),
    middleName: optText(50),
    lastName: reqText(50, 'Enter a last name'),
    suffix: optText(10),
    /** Write-only. Omit to keep the stored SSN, '' to remove it. */
    ssn: ssnSchema.optional().or(z.literal('')),
    dateOfBirth: optDate,
    email: z
      .union([z.literal('').transform(() => null), z.email('Enter a valid email')])
      .nullable()
      .optional(),
    phone: optText(40),
    addressLine1: optText(200),
    addressLine2: optText(200),
    city: optText(100),
    state: optState,
    postalCode: optZip,
    workAddressLine1: optText(200),
    workCity: optText(100),
    workState: z.enum(PAYROLL_STATES, 'Payroll supports work in CA, FL, IL, NY and TX for now'),
    workPostalCode: optZip,
    hireDate: isoDate,
    terminationDate: optDate,
    terminationReason: optText(200),
    payType: z.enum(PAY_TYPES),
    /** Hourly: the rate per hour. Salary: the annual salary. */
    payRate: z
      .union([z.literal('').transform(() => '0'), decimal(4, 99999999, 'Enter an amount')])
      .default('0'),
    defaultHours: optDecimal(2, 744, 'Enter hours, such as 80'),
    payScheduleId: z.uuid('Choose a pay schedule'),
    payMethod: z.enum(PAY_METHODS).default('check'),
    overtimeExempt: z.boolean().default(false),
    /** The company member who approves this employee's time (ADR 0019). */
    managerUserId: z.uuid().nullable().optional(),
    /** New York: filed Form DB-130 (receiving social security), so no DBL contribution. */
    nyDblExempt: z.boolean().default(false),
    /** Form W-2 box 14b: up to two Treasury tipped occupation codes, e.g. "101" or "101 203". */
    tippedOccupationCodes: z
      .union([
        z.literal('').transform(() => null),
        z
          .string()
          .trim()
          .transform((v) => v.replace(/[,\s]+/g, ' '))
          .pipe(
            z
              .string()
              .regex(/^[0-9]{3}( [0-9]{3})?$/, 'Enter one or two three-digit codes, e.g. 101 203'),
          ),
      ])
      .nullable()
      .optional(),
    workersCompClassId: z.uuid().nullable().optional(),
    classId: z.uuid().nullable().optional(),
    locationId: z.uuid().nullable().optional(),
    notes: optText(4000),
  })
  .superRefine((v, ctx) => {
    if (v.terminationDate && v.terminationDate < v.hireDate) {
      ctx.addIssue({
        code: 'custom',
        path: ['terminationDate'],
        message: 'The last day is before the hire date',
      });
    }
    if (v.terminationReason && !v.terminationDate) {
      ctx.addIssue({
        code: 'custom',
        path: ['terminationDate'],
        message: 'Enter the last day worked',
      });
    }
    if (v.payType !== 'commission' && compareDecimal(v.payRate, '0') === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['payRate'],
        message: v.payType === 'hourly' ? 'Enter the hourly rate' : 'Enter the annual salary',
      });
    }
  });
export type EmployeeInput = z.input<typeof employeeInputSchema>;

export type EmployeeStatus = 'active' | 'terminated';

export interface EmployeeSummaryDto {
  id: string;
  employeeNumber: string | null;
  displayName: string;
  firstName: string;
  lastName: string;
  status: EmployeeStatus;
  payType: PayType;
  payRate: string;
  payScheduleId: string;
  payMethod: PayMethod;
  workState: PayrollState;
  hireDate: string;
  terminationDate: string | null;
  ssnMasked: string | null;
  /** Things missing before this employee can be paid. */
  missing: string[];
}

export interface EmployeeDto extends EmployeeSummaryDto {
  middleName: string | null;
  suffix: string | null;
  dateOfBirth: string | null;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  workAddressLine1: string | null;
  workCity: string | null;
  workPostalCode: string | null;
  terminationReason: string | null;
  defaultHours: string | null;
  overtimeExempt: boolean;
  managerUserId: string | null;
  nyDblExempt: boolean;
  tippedOccupationCodes: string | null;
  workersCompClassId: string | null;
  classId: string | null;
  locationId: string | null;
  notes: string | null;
  w4: W4Dto[];
  stateCertificates: StateCertificateDto[];
  bankAccounts: BankAccountDto[];
  payItems: EmployeePayItemDto[];
  pto: EmployeePtoDto[];
}

export function employeeDisplayName(e: {
  firstName: string;
  middleName?: string | null;
  lastName: string;
  suffix?: string | null;
}): string {
  return [e.firstName, e.middleName, e.lastName, e.suffix].filter(Boolean).join(' ');
}

export function employeeStatus(terminationDate: string | null, today: IsoDate): EmployeeStatus {
  return terminationDate && terminationDate < today ? 'terminated' : 'active';
}

// ---- Form W-4 ---------------------------------------------------------------------------------
export const W4_VERSIONS = ['2020', 'pre2020'] as const;
export type W4Version = (typeof W4_VERSIONS)[number];
export const W4_2020_STATUSES = ['single', 'married_jointly', 'head_of_household'] as const;
export const W4_PRE2020_STATUSES = ['single', 'married', 'married_single_rate'] as const;
export type W4FilingStatus =
  (typeof W4_2020_STATUSES)[number] | (typeof W4_PRE2020_STATUSES)[number];
export const W4_2020_STATUS_LABELS: Record<(typeof W4_2020_STATUSES)[number], string> = {
  single: 'Single or Married filing separately',
  married_jointly: 'Married filing jointly (or Qualifying surviving spouse)',
  head_of_household: 'Head of household',
};
export const W4_PRE2020_STATUS_LABELS: Record<(typeof W4_PRE2020_STATUSES)[number], string> = {
  single: 'Single',
  married: 'Married',
  married_single_rate: 'Married, but withhold at higher Single rate',
};

const w4Common = {
  effectiveFrom: isoDate,
  extraWithholding: moneyOrZero,
  exempt: z.boolean().default(false),
  nonresidentAlien: z.boolean().default(false),
};

export const w4InputSchema = z.discriminatedUnion('formVersion', [
  z.object({
    formVersion: z.literal('2020'),
    filingStatus: z.enum(W4_2020_STATUSES),
    /** Step 2(c): two jobs, or married filing jointly with a working spouse. */
    multipleJobs: z.boolean().default(false),
    /** Step 3. */
    dependentsAmount: moneyOrZero,
    /** Step 4(a). */
    otherIncome: moneyOrZero,
    /** Step 4(b). */
    deductions: moneyOrZero,
    ...w4Common,
  }),
  z.object({
    formVersion: z.literal('pre2020'),
    filingStatus: z.enum(W4_PRE2020_STATUSES),
    /** Line 5. */
    allowances: z.number().int().min(0).max(99),
    ...w4Common,
  }),
]);
export type W4Input = z.input<typeof w4InputSchema>;

export interface W4Dto {
  id: string;
  effectiveFrom: string;
  formVersion: W4Version;
  filingStatus: W4FilingStatus;
  multipleJobs: boolean;
  dependentsAmount: string;
  otherIncome: string;
  deductions: string;
  extraWithholding: string;
  allowances: number;
  exempt: boolean;
  nonresidentAlien: boolean;
  createdAt: string;
}

// ---- State withholding certificates -----------------------------------------------------------
const allowances = z.number().int().min(0).max(99).default(0);

/** Illinois Form IL-W-4. */
export const ilW4FieldsSchema = z.object({
  /** Line 1: basic allowances. */
  basicAllowances: allowances,
  /** Line 2: additional allowances. */
  additionalAllowances: allowances,
  /** Line 3: additional amount to withhold each pay period. */
  additionalWithholding: moneyOrZero,
  exempt: z.boolean().default(false),
});

export const DE4_STATUSES = ['single', 'married', 'head_of_household'] as const;
export const DE4_STATUS_LABELS: Record<(typeof DE4_STATUSES)[number], string> = {
  single: 'Single or Married (with two or more incomes)',
  married: 'Married (one income)',
  head_of_household: 'Head of household',
};
/** California Form DE 4. */
export const caDe4FieldsSchema = z.object({
  filingStatus: z.enum(DE4_STATUSES),
  /** Line 1a: allowances for Worksheet A (regular withholding allowances). */
  regularAllowances: allowances,
  /** Line 1b: allowances for Worksheet B (estimated deductions). */
  estimatedDeductionAllowances: allowances,
  /** Line 2: additional amount to withhold each pay period. */
  additionalWithholding: moneyOrZero,
  /** Line 3: exemption for the year (renewed by February 15). */
  exempt: z.boolean().default(false),
  /** Line 4: not subject to California withholding as a military spouse (DE 4 Rev. 56, 1-26). */
  militarySpouseExempt: z.boolean().default(false),
});

export const IT2104_STATUSES = ['single', 'married', 'married_single_rate'] as const;
export const IT2104_STATUS_LABELS: Record<(typeof IT2104_STATUSES)[number], string> = {
  single: 'Single or Head of household',
  married: 'Married',
  married_single_rate: 'Married, but withhold at higher single rate',
};
/** New York Form IT-2104 (and IT-2104-E for exemption). */
export const nyIt2104FieldsSchema = z.object({
  filingStatus: z.enum(IT2104_STATUSES),
  nycResident: z.boolean().default(false),
  yonkersResident: z.boolean().default(false),
  /** Line 1: New York State and Yonkers allowances. */
  stateAllowances: allowances,
  /** Line 2: New York City allowances. */
  cityAllowances: allowances,
  /** Lines 3 to 5: additional amounts per pay period. */
  additionalState: moneyOrZero,
  additionalCity: moneyOrZero,
  additionalYonkers: moneyOrZero,
  /** Form IT-2104-E on file. */
  exempt: z.boolean().default(false),
});

export const stateCertificateInputSchema = z
  .discriminatedUnion('state', [
    z.object({ state: z.literal('IL'), effectiveFrom: isoDate, fields: ilW4FieldsSchema }),
    z.object({ state: z.literal('CA'), effectiveFrom: isoDate, fields: caDe4FieldsSchema }),
    z.object({ state: z.literal('NY'), effectiveFrom: isoDate, fields: nyIt2104FieldsSchema }),
  ])
  .superRefine((v, ctx) => {
    if (v.state === 'NY' && v.fields.nycResident && v.fields.yonkersResident) {
      ctx.addIssue({
        code: 'custom',
        path: ['fields', 'yonkersResident'],
        message: 'An employee lives in New York City or Yonkers, not both',
      });
    }
  });
export type StateCertificateInput = z.input<typeof stateCertificateInputSchema>;
export type IlW4Fields = z.output<typeof ilW4FieldsSchema>;
export type CaDe4Fields = z.output<typeof caDe4FieldsSchema>;
export type NyIt2104Fields = z.output<typeof nyIt2104FieldsSchema>;

export type StateCertificateDto = { id: string; effectiveFrom: string; createdAt: string } & (
  | { state: 'IL'; fields: IlW4Fields }
  | { state: 'CA'; fields: CaDe4Fields }
  | { state: 'NY'; fields: NyIt2104Fields }
);

// ---- Direct deposit ---------------------------------------------------------------------------
export const BANK_ACCOUNT_TYPES = ['checking', 'savings'] as const;
export type BankAccountType = (typeof BANK_ACCOUNT_TYPES)[number];
export const DEPOSIT_AMOUNT_TYPES = ['fixed', 'percent', 'remainder'] as const;
export type DepositAmountType = (typeof DEPOSIT_AMOUNT_TYPES)[number];
export const DEPOSIT_AMOUNT_TYPE_LABELS: Record<DepositAmountType, string> = {
  fixed: 'A fixed amount',
  percent: 'A percentage of net pay',
  remainder: 'The rest of net pay',
};
export const MAX_DEPOSIT_ACCOUNTS = 3;

const bankAccountInput = z.object({
  /** An existing account; omit accountNumber to keep its number. */
  id: z.uuid().optional(),
  routingNumber: routingNumberSchema,
  /** Write-only. Required for a new account. */
  accountNumber: z
    .string()
    .trim()
    .regex(/^\d{4,17}$/, 'An account number has 4 to 17 digits')
    .optional(),
  accountType: z.enum(BANK_ACCOUNT_TYPES),
  amountType: z.enum(DEPOSIT_AMOUNT_TYPES),
  /** Dollars (fixed) or percent of net pay (percent). */
  amount: optDecimal(2, 99999999, 'Enter an amount'),
  /** Send a zero-dollar test entry (prenote) before the first deposit. */
  prenote: z.boolean().default(false),
});

export const bankAccountsInputSchema = z
  .object({ accounts: z.array(bankAccountInput).max(MAX_DEPOSIT_ACCOUNTS) })
  .superRefine(({ accounts }, ctx) => {
    if (accounts.length === 0) return;
    let percent = 0n;
    accounts.forEach((a, i) => {
      if (!a.id && !a.accountNumber) {
        ctx.addIssue({
          code: 'custom',
          path: ['accounts', i, 'accountNumber'],
          message: 'Enter the account number',
        });
      }
      if (a.amountType === 'remainder') {
        if (a.amount) {
          ctx.addIssue({
            code: 'custom',
            path: ['accounts', i, 'amount'],
            message: 'The account that gets the rest has no amount',
          });
        }
        if (i !== accounts.length - 1) {
          ctx.addIssue({
            code: 'custom',
            path: ['accounts', i, 'amountType'],
            message: 'The account that gets the rest comes last',
          });
        }
        return;
      }
      if (!a.amount || compareDecimal(a.amount, '0') === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['accounts', i, 'amount'],
          message: 'Enter an amount',
        });
      } else if (a.amountType === 'percent') {
        percent += parseMoney(a.amount);
      }
    });
    if (accounts.filter((a) => a.amountType === 'remainder').length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['accounts'],
        message: 'Exactly one account gets the rest of net pay',
      });
    }
    if (percent > parseMoney('100')) {
      ctx.addIssue({
        code: 'custom',
        path: ['accounts'],
        message: 'The percentages add up to more than 100%',
      });
    }
  });
export type BankAccountsInput = z.input<typeof bankAccountsInputSchema>;

export type PrenoteStatus = 'none' | 'pending' | 'sent';

export interface BankAccountDto {
  id: string;
  position: number;
  routingNumber: string;
  /** e.g. "****6789". */
  accountMasked: string;
  accountType: BankAccountType;
  amountType: DepositAmountType;
  amount: string | null;
  prenoteStatus: PrenoteStatus;
  prenoteSentOn: string | null;
}

// ---- Recurring earnings and deductions --------------------------------------------------------
export const employeePayItemsInputSchema = z.object({
  items: z
    .array(
      z
        .object({
          payrollItemId: z.uuid('Choose a payroll item'),
          amount: optMoney,
          percent: optDecimal(4, 100, 'Enter a percentage such as 5'),
          annualLimit: optMoney,
          caseNumber: optText(50),
          totalOwed: optMoney,
        })
        .superRefine((v, ctx) => {
          if (!v.amount === !v.percent) {
            ctx.addIssue({
              code: 'custom',
              path: ['amount'],
              message: 'Enter an amount or a percentage (not both)',
            });
          }
        }),
    )
    .max(50),
});
export type EmployeePayItemsInput = z.input<typeof employeePayItemsInputSchema>;

export interface EmployeePayItemDto {
  id: string;
  payrollItemId: string;
  amount: string | null;
  percent: string | null;
  annualLimit: string | null;
  caseNumber: string | null;
  totalOwed: string | null;
}

// ---- PTO --------------------------------------------------------------------------------------
export const employeePtoInputSchema = z.object({
  policies: z
    .array(
      z.object({
        policyId: z.uuid(),
        /** Hours available on `openingAsOf` (may be negative if the policy allows borrowing). */
        openingBalance: z
          .string()
          .trim()
          .regex(/^-?\d{1,5}(\.\d{1,2})?$/, 'Enter hours, such as 16 or 7.5')
          .default('0'),
        openingAsOf: isoDate,
      }),
    )
    .max(10),
});
export type EmployeePtoInput = z.input<typeof employeePtoInputSchema>;

export interface EmployeePtoDto {
  policyId: string;
  openingBalance: string;
  openingAsOf: string;
}

// ---------------------------------------------------------------------------------------------
// Direct deposit files
// ---------------------------------------------------------------------------------------------
export interface AchBatchDto {
  id: string;
  kind: 'prenote' | 'payroll';
  effectiveDate: string;
  entryCount: number;
  totalCredit: string;
  fileSha256: string;
  createdAt: string;
}

export const prenoteFileInputSchema = z.object({
  /** The date the bank should settle the entries (usually the next business day). */
  effectiveDate: isoDate,
});
export type PrenoteFileInput = z.input<typeof prenoteFileInputSchema>;

// ---------------------------------------------------------------------------------------------
// Lookups for payroll screens (so payroll admins need no ledger or purchases access)
// ---------------------------------------------------------------------------------------------
export interface PayrollLookupsDto {
  /** Active expense, liability and bank accounts ("Parent:Child" names). */
  accounts: { id: string; fullName: string; accountType: string }[];
  vendors: { id: string; displayName: string }[];
  classes: { id: string; fullName: string }[];
  locations: { id: string; fullName: string }[];
  /** Company members, to name who approves an employee's time. */
  members: { userId: string; fullName: string }[];
}

/** A direct deposit account waiting for its prenote. */
export interface PendingPrenoteDto {
  employeeId: string;
  employeeName: string;
  accountMasked: string;
  accountType: BankAccountType;
}

// ---------------------------------------------------------------------------------------------
// Pay runs and paychecks (Phase 8, part 2)
// ---------------------------------------------------------------------------------------------
export const PAY_RUN_KINDS = ['regular', 'off_cycle', 'bonus', 'final'] as const;
export type PayRunKind = (typeof PAY_RUN_KINDS)[number];
export const PAY_RUN_KIND_LABELS: Record<PayRunKind, string> = {
  regular: 'Regular',
  off_cycle: 'Off-cycle',
  bonus: 'Bonus',
  final: 'Final paycheck',
};
export const PAY_RUN_STATUSES = ['draft', 'approved', 'posted'] as const;
export type PayRunStatus = (typeof PAY_RUN_STATUSES)[number];
export type PaycheckStatus = 'draft' | 'posted' | 'void';

/** Payroll taxes the tax engine calculates (codes stored on paycheck lines). */
export const PAYROLL_TAX_CODES = [
  'federal_income',
  'social_security_employee',
  'social_security_employer',
  'medicare_employee',
  'medicare_employer',
  'additional_medicare',
  'futa',
  'state_income',
  'nyc_income',
  'yonkers_income',
  'state_unemployment',
  'ny_reemployment_fund',
  'ca_ett',
  'ca_sdi',
  'ny_pfl',
  'ny_dbl',
] as const;
export type PayrollTaxCode = (typeof PAYROLL_TAX_CODES)[number];
/** Labels; state taxes are prefixed with the state on screen ("NY income tax"). */
export const PAYROLL_TAX_LABELS: Record<PayrollTaxCode, string> = {
  federal_income: 'Federal income tax',
  social_security_employee: 'Social security',
  social_security_employer: 'Social security (company)',
  medicare_employee: 'Medicare',
  medicare_employer: 'Medicare (company)',
  additional_medicare: 'Additional Medicare',
  futa: 'Federal unemployment (FUTA)',
  state_income: 'income tax',
  nyc_income: 'New York City income tax',
  yonkers_income: 'Yonkers income tax',
  state_unemployment: 'unemployment',
  ny_reemployment_fund: 'NY Re-employment Service Fund',
  ca_ett: 'CA Employment Training Tax',
  ca_sdi: 'CA SDI',
  ny_pfl: 'NY Paid Family Leave',
  ny_dbl: 'NY Disability Benefits (DBL)',
};
export function payrollTaxLabel(code: PayrollTaxCode, state: string | null): string {
  const label = PAYROLL_TAX_LABELS[code];
  return (code === 'state_income' || code === 'state_unemployment') && state
    ? `${state} ${label}`
    : label;
}

export const createPayRunSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('regular'),
    payScheduleId: z.uuid('Choose a pay schedule'),
    /** The period to pay; the schedule's next unpaid period when left out. */
    periodEnd: isoDate.optional(),
    /** The pay date; the schedule's pay date for the period when left out. */
    payDate: isoDate.optional(),
    memo: z.string().trim().max(500).optional(),
  }),
  z.object({
    kind: z.enum(['off_cycle', 'bonus', 'final']),
    payDate: isoDate,
    /** The pay frequency used for withholding. */
    frequency: z.enum(PAY_FREQUENCIES),
    employeeIds: z.array(z.uuid()).min(1, 'Choose at least one employee').max(500),
    memo: z.string().trim().max(500).optional(),
  }),
]);
export type CreatePayRunInput = z.input<typeof createPayRunSchema>;

const hours = optDecimal(2, 9999, 'Enter hours like 40 or 7.5');
const rate = optDecimal(4, 99999999, 'Enter a rate like 25.50');

/** One paycheck's earnings, deductions and company contributions; taxes are calculated. */
export const paycheckInputSchema = z.object({
  earnings: z
    .array(
      z.object({
        payrollItemId: z.uuid('Choose an item'),
        /** Hours at a rate (hourly, overtime, PTO), or an amount (salary, bonus...). */
        hours,
        rate,
        amount: optMoney,
      }),
    )
    .max(50),
  deductions: z.array(z.object({ payrollItemId: z.uuid('Choose an item'), amount: money })).max(50),
  contributions: z
    .array(z.object({ payrollItemId: z.uuid('Choose an item'), amount: money }))
    .max(50),
  payMethod: z.enum(['check', 'direct_deposit']).optional(),
});
export type PaycheckInput = z.input<typeof paycheckInputSchema>;

export const payrollDepositFileSchema = z.object({
  /** The settlement date the bank should use (usually the pay date). */
  effectiveDate: isoDate,
});

export const voidPaycheckSchema = z.object({
  reason: z.string().trim().min(1, 'Enter a reason').max(200),
});

export interface PaycheckSummaryDto {
  id: string;
  employeeId: string;
  employeeName: string;
  payMethod: PayMethod;
  status: PaycheckStatus;
  grossPay: string;
  employeeTaxes: string;
  deductions: string;
  netPay: string;
  employerTaxes: string;
  contributions: string;
  /** Why taxes couldn't be calculated; the run can't be approved until these are resolved. */
  problems: string[];
  notices: string[];
  transactionId: string | null;
}

export interface PayRunSummaryDto {
  id: string;
  kind: PayRunKind;
  status: PayRunStatus;
  payScheduleId: string | null;
  payScheduleName: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  payDate: string;
  frequency: PayFrequency;
  paycheckCount: number;
  grossPay: string;
  netPay: string;
  employerTaxes: string;
  /** What the run costs the company: gross pay, company taxes and contributions. */
  totalCost: string;
  problemCount: number;
  createdAt: string;
}

export interface PayRunDto extends PayRunSummaryDto {
  memo: string | null;
  approvedAt: string | null;
  postedAt: string | null;
  paychecks: PaycheckSummaryDto[];
  /** Totals of each tax across the run (employee and company). */
  taxes: {
    code: PayrollTaxCode;
    state: string | null;
    label: string;
    payer: 'employee' | 'employer';
    amount: string;
  }[];
  /** A payroll direct deposit file has been created for this run. */
  depositFileCreated: boolean;
}

export interface PaycheckLineDto {
  lineType: 'earning' | 'deduction' | 'contribution' | 'tax';
  payrollItemId: string | null;
  kind: PayrollItemKind | null;
  taxCode: PayrollTaxCode | null;
  payer: 'employee' | 'employer' | null;
  state: string | null;
  label: string;
  hours: string | null;
  rate: string | null;
  amount: string;
  taxableWages: string | null;
  /** Year to date through this paycheck (posted paychecks in the calendar year). */
  ytd: string;
}

/** A paycheck with everything a pay stub shows. */
export interface PaycheckDto extends PaycheckSummaryDto {
  payRunId: string;
  payRunStatus: PayRunStatus;
  payDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  supplemental: boolean;
  employeeNumber: string | null;
  ssnMasked: string | null;
  companyName: string;
  lines: PaycheckLineDto[];
  ytd: { grossPay: string; employeeTaxes: string; deductions: string; netPay: string };
  /**
   * What was entered: earnings, and amounts that replace (or, at "0", skip) a recurring
   * deduction or contribution for this paycheck. Recurring items not listed are calculated.
   */
  input: {
    earnings: {
      payrollItemId: string;
      hours: string | null;
      rate: string | null;
      amount: string | null;
    }[];
    deductions: { payrollItemId: string; amount: string }[];
    contributions: { payrollItemId: string; amount: string }[];
  };
  /** Where net pay went (masked accounts), for direct deposit. */
  deposits: { accountMasked: string; accountType: BankAccountType; amount: string }[];
  voidedAt: string | null;
}

// ---------------------------------------------------------------------------------------------
// Payroll liabilities and payments (Phase 8, part 2)
// ---------------------------------------------------------------------------------------------
/**
 * Who a payroll liability is owed to:
 *   federal_941 (income tax withheld, social security, Medicare), federal_940 (FUTA),
 *   state_withholding:<ST> (state and local income tax, CA SDI), state_unemployment:<ST>
 *   (unemployment, NY Re-employment Service Fund, CA ETT), ny_pfl and ny_dbl (the employer's Paid
 *   Family Leave and disability benefits carrier), item:<payroll item id> (a deduction or contribution's payee).
 */
export type PayrollAgency = string;

export const LIABILITY_PAYMENT_METHODS = ['eftps', 'ach', 'check', 'other'] as const;
export type LiabilityPaymentMethod = (typeof LIABILITY_PAYMENT_METHODS)[number];
export const LIABILITY_PAYMENT_METHOD_LABELS: Record<LiabilityPaymentMethod, string> = {
  eftps: 'EFTPS',
  ach: 'Electronic payment',
  check: 'Check',
  other: 'Other',
};

export type PayrollLiabilityStatus = 'paid' | 'overdue' | 'due_soon' | 'open' | 'no_due_date';

export interface PayrollLiabilityDto {
  agency: PayrollAgency;
  agencyLabel: string;
  periodStart: string;
  periodEnd: string;
  /** When it must be paid; null when the due date isn't in tax-data (see dueNote). */
  dueDate: string | null;
  dueNote: string | null;
  /** The $100,000 next-day deposit rule applied. */
  nextDay: boolean;
  accrued: string;
  paid: string;
  balance: string;
  status: PayrollLiabilityStatus;
  /** What makes up the amount (each tax, or the item). */
  parts: { label: string; amount: string }[];
}

export interface PayrollLiabilitiesDto {
  asOf: string;
  liabilities: PayrollLiabilityDto[];
  depositSchedule: {
    /** The schedule in Payroll › Setup. */
    setting: 'monthly' | 'semiweekly';
    /** The schedule in effect today (semiweekly after a $100,000 day this year). */
    effective: 'monthly' | 'semiweekly';
    lookback: {
      from: string;
      to: string;
      /** Form 941 taxes recorded here for the lookback period. */
      total: string;
      suggested: 'monthly' | 'semiweekly';
      /** Payroll here doesn't cover the whole lookback period, so the total may be short. */
      incomplete: boolean;
    } | null;
  };
  notes: string[];
}

export const payrollLiabilityPaymentSchema = z.object({
  agency: z.string().trim().min(1).max(80),
  periodStart: isoDate,
  periodEnd: isoDate,
  paymentDate: isoDate,
  amount: money,
  method: z.enum(LIABILITY_PAYMENT_METHODS),
  /** The EFT acknowledgement number, check number or confirmation. */
  reference: optText(40),
  /** Defaults to the account paychecks are paid from. */
  bankAccountId: z.uuid().nullable().optional(),
});
export type PayrollLiabilityPaymentInput = z.input<typeof payrollLiabilityPaymentSchema>;

export interface PayrollLiabilityPaymentDto {
  id: string;
  agency: PayrollAgency;
  agencyLabel: string;
  periodStart: string;
  periodEnd: string;
  paymentDate: string;
  amount: string;
  method: LiabilityPaymentMethod;
  reference: string | null;
  status: 'posted' | 'void';
  transactionId: string;
  createdAt: string;
  /** For EFTPS without a connected provider: what to enter in EFTPS. */
  instructions?: string[];
}

export const PAYROLL_REPORT_KEYS = [
  'payroll_summary',
  'paycheck_history',
  'payroll_tax_liability',
] as const;
export type PayrollReportKey = (typeof PAYROLL_REPORT_KEYS)[number];
export const PAYROLL_REPORT_TITLES: Record<PayrollReportKey, string> = {
  payroll_summary: 'Payroll Summary',
  paycheck_history: 'Paycheck History',
  payroll_tax_liability: 'Payroll Tax and Wage Summary',
};
export const payrollReportQuerySchema = z
  .object({ from: isoDate, to: isoDate })
  .refine((v) => v.from <= v.to, {
    message: 'The start date is after the end date',
    path: ['from'],
  });

// ---------------------------------------------------------------------------------------------
// Prior payroll (Phase 9): pay from before payroll started here
// ---------------------------------------------------------------------------------------------
/** Who pays each tax. */
export const PAYROLL_TAX_PAYERS: Record<PayrollTaxCode, 'employee' | 'employer'> = {
  federal_income: 'employee',
  social_security_employee: 'employee',
  social_security_employer: 'employer',
  medicare_employee: 'employee',
  medicare_employer: 'employer',
  additional_medicare: 'employee',
  futa: 'employer',
  state_income: 'employee',
  nyc_income: 'employee',
  yonkers_income: 'employee',
  state_unemployment: 'employer',
  ny_reemployment_fund: 'employer',
  ca_ett: 'employer',
  ca_sdi: 'employee',
  ny_pfl: 'employee',
  ny_dbl: 'employee',
};
/** Which state a tax line names: none (federal), any work state, or one state. */
export const PAYROLL_TAX_STATES: Record<PayrollTaxCode, 'none' | 'any' | PayrollState> = {
  federal_income: 'none',
  social_security_employee: 'none',
  social_security_employer: 'none',
  medicare_employee: 'none',
  medicare_employer: 'none',
  additional_medicare: 'none',
  futa: 'none',
  state_income: 'any',
  nyc_income: 'NY',
  yonkers_income: 'NY',
  state_unemployment: 'any',
  ny_reemployment_fund: 'NY',
  ca_ett: 'CA',
  ca_sdi: 'CA',
  ny_pfl: 'NY',
  ny_dbl: 'NY',
};

export const priorPayrollInputSchema = z
  .object({
    employeeId: z.uuid('Choose an employee'),
    /** The pay date, or the last pay date of the period the totals cover. */
    payDate: isoDate,
    memo: optText(200),
    /** Earnings, deductions and company contributions paid, by payroll item. */
    items: z
      .array(z.object({ payrollItemId: z.uuid('Choose a payroll item'), amount: money }))
      .max(100)
      .default([]),
    /** Taxes withheld and paid, with the wages they were figured on. */
    taxes: z
      .array(
        z.object({
          taxCode: z.enum(PAYROLL_TAX_CODES),
          state: z.enum(PAYROLL_STATES).nullable().optional(),
          /** Wages the tax was figured on (after any wage base). */
          taxableWages: money,
          /** Wages subject to the tax before any wage base; blank means the same. */
          subjectWages: optMoney,
          amount: money,
        }),
      )
      .max(60)
      .default([]),
  })
  .superRefine((v, ctx) => {
    if (v.items.length === 0 && v.taxes.length === 0)
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'Enter the pay or the taxes' });
    const seen = new Set<string>();
    v.taxes.forEach((t, i) => {
      const rule = PAYROLL_TAX_STATES[t.taxCode];
      const state = rule === 'none' || rule === 'any' ? (t.state ?? null) : rule;
      if (rule === 'none' && t.state)
        ctx.addIssue({
          code: 'custom',
          path: ['taxes', i, 'state'],
          message: 'A federal tax has no state',
        });
      if (rule === 'any' && !t.state)
        ctx.addIssue({ code: 'custom', path: ['taxes', i, 'state'], message: 'Choose the state' });
      if (rule !== 'none' && rule !== 'any' && t.state && t.state !== rule)
        ctx.addIssue({
          code: 'custom',
          path: ['taxes', i, 'state'],
          message: `This tax is ${rule}'s`,
        });
      const key = `${t.taxCode}|${state ?? ''}`;
      if (seen.has(key))
        ctx.addIssue({
          code: 'custom',
          path: ['taxes', i, 'taxCode'],
          message: 'This tax is entered twice',
        });
      seen.add(key);
      if (t.subjectWages && parseMoney(t.subjectWages) < parseMoney(t.taxableWages))
        ctx.addIssue({
          code: 'custom',
          path: ['taxes', i, 'subjectWages'],
          message: 'Wages before the wage base cannot be less than the taxable wages',
        });
    });
    const items = new Set<string>();
    v.items.forEach((it, i) => {
      if (items.has(it.payrollItemId))
        ctx.addIssue({
          code: 'custom',
          path: ['items', i, 'payrollItemId'],
          message: 'This item is entered twice',
        });
      items.add(it.payrollItemId);
    });
  });
export type PriorPayrollInput = z.input<typeof priorPayrollInputSchema>;

export interface PriorPayrollDto {
  id: string;
  employeeId: string;
  employeeName: string;
  payDate: string;
  memo: string | null;
  items: {
    payrollItemId: string;
    name: string;
    kind: PayrollItemKind;
    category: PayrollItemCategory;
    amount: string;
  }[];
  taxes: {
    taxCode: PayrollTaxCode;
    state: PayrollState | null;
    payer: 'employee' | 'employer';
    taxableWages: string;
    subjectWages: string;
    amount: string;
  }[];
  grossPay: string;
  employeeTaxes: string;
  employerTaxes: string;
  /** Why it can't change (a filed form covers its period), or null. */
  lockedBy: string | null;
}

// ---------------------------------------------------------------------------------------------
// Payroll tax forms (Phase 9)
// ---------------------------------------------------------------------------------------------
export const TAX_FILING_FORMS = ['form_941', 'form_940', 'w2', 'state_quarterly'] as const;
export type TaxFilingForm = (typeof TAX_FILING_FORMS)[number];
export const TAX_FILING_FORM_LABELS: Record<TaxFilingForm, string> = {
  form_941: 'Form 941',
  form_940: 'Form 940',
  w2: 'Forms W-2 and W-3',
  state_quarterly: 'State quarterly reports',
};
export const TAX_FILING_METHODS = ['electronic', 'paper', 'provider'] as const;
export type TaxFilingMethod = (typeof TAX_FILING_METHODS)[number];
export const TAX_FILING_METHOD_LABELS: Record<TaxFilingMethod, string> = {
  electronic: 'Filed electronically',
  paper: 'Mailed on paper',
  provider: 'Filed by a payroll provider',
};

export const taxFilingInputSchema = z
  .object({
    form: z.enum(TAX_FILING_FORMS),
    taxYear: z.number().int().min(2000).max(2199),
    quarter: z.number().int().min(1).max(4).nullable().optional(),
    state: z.enum(PAYROLL_STATES).nullable().optional(),
    filedOn: isoDate,
    method: z.enum(TAX_FILING_METHODS),
    confirmation: optText(60),
  })
  .superRefine((v, ctx) => {
    const quarterly = v.form === 'form_941' || v.form === 'state_quarterly';
    if (quarterly && !v.quarter)
      ctx.addIssue({ code: 'custom', path: ['quarter'], message: 'Choose the quarter' });
    if (!quarterly && v.quarter)
      ctx.addIssue({ code: 'custom', path: ['quarter'], message: 'This form is annual' });
    if ((v.form === 'state_quarterly') !== !!v.state)
      ctx.addIssue({
        code: 'custom',
        path: ['state'],
        message: v.state ? 'Only state reports name a state' : 'Choose the state',
      });
  });
export type TaxFilingInput = z.input<typeof taxFilingInputSchema>;

export interface TaxFilingDto {
  id: string;
  form: TaxFilingForm;
  label: string;
  taxYear: number;
  quarter: number | null;
  state: PayrollState | null;
  filedOn: string;
  method: TaxFilingMethod;
  confirmation: string | null;
  status: 'filed' | 'void';
  createdAt: string;
  voidedAt: string | null;
}

/** What a form shows about its filing: the filing, and what changed since (a correction). */
export interface FormFilingState {
  filing: TaxFilingDto | null;
  /** Figures that differ from what was filed, e.g. "Box 2: filed 1,200.00, now 1,150.00". */
  changedSinceFiled: string[];
}

export interface W2Dto {
  employeeId: string;
  employeeName: string;
  ssnMasked: string | null;
  address: string | null;
  box1: string;
  box2: string;
  box3: string;
  box4: string;
  box5: string;
  box6: string;
  box7: string;
  box10: string;
  box12: { code: string; amount: string }[];
  retirementPlan: boolean;
  box14a: { label: string; amount: string }[];
  box14b: string | null;
  states: { state: string; employerStateId: string | null; wages: string; tax: string }[];
  localities: { state: string; locality: string; wages: string; tax: string }[];
  /** Must be fixed before filing (e.g. a missing SSN, box 5 less than boxes 3 and 7). */
  problems: string[];
  /** Good to know (e.g. more than four box 12 items needs a second Copy A). */
  notes: string[];
}

export interface W3Dto {
  kindOfPayer: '941' | '944';
  kindOfEmployer: string;
  count: number;
  employerName: string;
  einLast4: string | null;
  box1: string;
  box2: string;
  box3: string;
  box4: string;
  box5: string;
  box6: string;
  box7: string;
  box10: string;
  box12a: string;
  /** The state, or "X" when the W-2s cover more than one. */
  state: string | null;
  employerStateId: string | null;
  box16: string;
  box17: string;
  box18: string;
  box19: string;
  problems: string[];
}

export interface W2FormsDto extends FormFilingState {
  taxYear: number;
  dueDate: string | null;
  w2s: W2Dto[];
  w3: W3Dto;
  /** Boxes 2, 3, 5 and 7 by quarter, to reconcile with Forms 941. */
  reconciliation: {
    quarter: number;
    box2: string;
    box3: string;
    box5: string;
    box7: string;
    filed941: boolean;
    differences: string[];
  }[];
}

export interface FederalQuarterDto extends FormFilingState {
  taxYear: number;
  quarter: number;
  depositSchedule: 'monthly' | 'semiweekly';
  employeesPaid: number;
  wages: string;
  federalIncomeTax: string;
  socialSecurityWages: string;
  socialSecurityTips: string;
  medicareWagesAndTips: string;
  additionalMedicareWages: string;
  socialSecurityTax: string;
  medicareTax: string;
  additionalMedicareTax: string;
  totalTaxes: string;
  /** Social security and Medicare figured on the quarter's wages at the full rates. */
  taxAtRates: string;
  /** Withheld and paid minus taxAtRates (fractions of cents across paychecks). */
  roundingDifference: string;
  monthlyLiability: string[];
  dailyLiability: { date: string; amount: string }[];
  /** All deposits for the quarter: recorded here plus those made before payroll started here. */
  deposits: string;
  /** The part of deposits made before payroll started here (Prior payroll). */
  priorDeposits: string;
  balanceDue: string;
  notes: string[];
}

export interface FutaAnnualDto extends FormFilingState {
  taxYear: number;
  subjectWages: string;
  wagesOverBase: string;
  taxableWages: string;
  tax: string;
  byState: { state: string; taxableWages: string }[];
  quarterlyLiability: string[];
  deposits: string;
  priorDeposits: string;
  balanceDue: string;
  notes: string[];
}

export interface StateQuarterDto extends FormFilingState {
  taxYear: number;
  quarter: number;
  state: PayrollState;
  stateName: string;
  /** The state's quarterly return, when tax-data names it (e.g. RT-6, DE 9). */
  form: string | null;
  dueDate: string | null;
  withholding: { code: PayrollTaxCode; label: string; wages: string; tax: string }[];
  unemployment: {
    employees: {
      employeeId: string;
      name: string;
      ssnMasked: string | null;
      subjectWages: string;
      excessWages: string;
      taxableWages: string;
      tax: string;
    }[];
    subjectWages: string;
    excessWages: string;
    taxableWages: string;
    tax: string;
  };
  otherEmployerTaxes: {
    code: PayrollTaxCode;
    label: string;
    taxableWages: string;
    amount: string;
  }[];
  notes: string[];
}

/** Which form period to show: a year, and a quarter and state where the form needs them. */
export const taxFormQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2199),
  quarter: z.coerce.number().int().min(1).max(4).optional(),
  state: z.enum(PAYROLL_STATES).optional(),
});
export type TaxFormQuery = z.input<typeof taxFormQuerySchema>;

// ---------------------------------------------------------------------------------------------
// Deposits made before payroll started here (Phase 9, open question 59)
// ---------------------------------------------------------------------------------------------
export const PRIOR_DEPOSIT_AGENCIES = ['federal_941', 'federal_940'] as const;
export type PriorDepositAgency = (typeof PRIOR_DEPOSIT_AGENCIES)[number];
export const PRIOR_DEPOSIT_AGENCY_LABELS: Record<PriorDepositAgency, string> = {
  federal_941: 'Form 941 taxes',
  federal_940: 'FUTA (Form 940)',
};

export const priorTaxDepositInputSchema = z.object({
  agency: z.enum(PRIOR_DEPOSIT_AGENCIES),
  taxYear: z.number().int().min(2000).max(2199),
  /** The quarter the deposit paid tax for. */
  quarter: z.number().int().min(1).max(4),
  paymentDate: isoDate,
  amount: money.refine((v) => parseMoney(v) > 0n, 'Enter the amount deposited'),
  memo: optText(200),
});
export type PriorTaxDepositInput = z.input<typeof priorTaxDepositInputSchema>;

export interface PriorTaxDepositDto {
  id: string;
  agency: PriorDepositAgency;
  agencyLabel: string;
  taxYear: number;
  quarter: number;
  paymentDate: string;
  amount: string;
  memo: string | null;
  /** Why it can't change (a filed form covers its period), or null. */
  lockedBy: string | null;
}
