import { z } from 'zod';
import { DATE_PRESETS, isIsoDate } from './dates';
import { ACCOUNT_TYPES } from './ledger';
import { MAX_AMOUNT, parseMoney } from './money';
import { REPORT_KEYS, reportFiltersShape, type ReportKey } from './reports';
import { POSTING_TXN_TYPES } from './sales';

const isoDate = z.string().refine(isIsoDate, 'Enter a valid date');

// ---------------------------------------------------------------------------------------------
// Custom report builder: transaction lines, chosen columns, filters, grouping and subtotals
// ---------------------------------------------------------------------------------------------
export const CUSTOM_COLUMNS = [
  'date',
  'txn_type',
  'number',
  'name',
  'memo',
  'account',
  'account_type',
  'class',
  'location',
  'due_date',
  'debit',
  'credit',
  'amount',
] as const;
export type CustomColumn = (typeof CUSTOM_COLUMNS)[number];
export const CUSTOM_COLUMN_LABELS: Record<CustomColumn, string> = {
  date: 'Date',
  txn_type: 'Transaction type',
  number: 'No.',
  name: 'Name',
  memo: 'Memo/Description',
  account: 'Account',
  account_type: 'Account type',
  class: 'Class',
  location: 'Location',
  due_date: 'Due date',
  debit: 'Debit',
  credit: 'Credit',
  amount: 'Amount',
};
/** Columns that hold money (right-aligned, summed in subtotals). */
export const CUSTOM_AMOUNT_COLUMNS: readonly CustomColumn[] = ['debit', 'credit', 'amount'];

export const CUSTOM_GROUPINGS = [
  'none',
  'account',
  'name',
  'customer',
  'vendor',
  'class',
  'location',
  'txn_type',
  'month',
  'quarter',
] as const;
export type CustomGrouping = (typeof CUSTOM_GROUPINGS)[number];
export const CUSTOM_GROUPING_LABELS: Record<CustomGrouping, string> = {
  none: 'No grouping',
  account: 'Account',
  name: 'Customer or vendor',
  customer: 'Customer',
  vendor: 'Vendor',
  class: 'Class',
  location: 'Location',
  txn_type: 'Transaction type',
  month: 'Month',
  quarter: 'Quarter',
};

const optAmount = z
  .string()
  .trim()
  .regex(/^\d{1,15}(\.\d{1,2})?$/, 'Enter an amount')
  .refine((v) => parseMoney(v) <= MAX_AMOUNT)
  .optional();

export const customReportDefinitionSchema = z
  .object({
    title: z.string().trim().min(1).max(100).default('Custom report'),
    columns: z
      .array(z.enum(CUSTOM_COLUMNS))
      .min(1, 'Choose at least one column')
      .max(CUSTOM_COLUMNS.length)
      .refine((c) => new Set(c).size === c.length, 'A column is chosen twice'),
    filters: z
      .object({
        accountIds: z.array(z.uuid()).max(200).optional(),
        accountTypes: z.array(z.enum(ACCOUNT_TYPES)).max(ACCOUNT_TYPES.length).optional(),
        txnTypes: z.array(z.enum(POSTING_TXN_TYPES)).max(POSTING_TXN_TYPES.length).optional(),
        customerId: z.uuid().optional(),
        vendorId: z.uuid().optional(),
        classId: z.uuid().optional(),
        locationId: z.uuid().optional(),
        /** On the line amount without its sign. */
        minAmount: optAmount,
        maxAmount: optAmount,
        /** Matches number, name, memo/description or account. */
        text: z.string().trim().max(100).optional(),
      })
      .default({}),
    groupBy: z.enum(CUSTOM_GROUPINGS).default('none'),
    subtotals: z.boolean().default(true),
    sortBy: z.enum(CUSTOM_COLUMNS).default('date'),
    sortDir: z.enum(['asc', 'desc']).default('asc'),
  })
  .refine(
    (d) =>
      !d.filters.minAmount ||
      !d.filters.maxAmount ||
      parseMoney(d.filters.minAmount) <= parseMoney(d.filters.maxAmount),
    { message: 'The minimum is more than the maximum', path: ['filters', 'minAmount'] },
  );
export type CustomReportDefinition = z.output<typeof customReportDefinitionSchema>;
export type CustomReportDefinitionInput = z.input<typeof customReportDefinitionSchema>;

export const customReportRunSchema = z
  .object({
    from: isoDate,
    to: isoDate,
    definition: customReportDefinitionSchema,
  })
  .refine((q) => q.from <= q.to, {
    message: 'Start date must be on or before end date',
    path: ['from'],
  });
export type CustomReportRunInput = z.input<typeof customReportRunSchema>;

// ---------------------------------------------------------------------------------------------
// Memorized reports and email schedules
// ---------------------------------------------------------------------------------------------

/**
 * A memorized report's settings. Dates are relative ("last month") unless `datePreset` is
 * "custom", so a scheduled report always covers the right period.
 */
export const memorizedParamsSchema = z
  .object({
    datePreset: z.enum([...DATE_PRESETS, 'custom'] as const).default('this_fiscal_year_to_date'),
    from: isoDate.optional(),
    to: isoDate.optional(),
    ...reportFiltersShape,
    definition: customReportDefinitionSchema.optional(),
  })
  .refine((p) => p.datePreset !== 'custom' || !!p.to, {
    message: 'Enter the report dates',
    path: ['to'],
  })
  .refine((p) => !p.from || !p.to || p.from <= p.to, {
    message: 'Start date must be on or before end date',
    path: ['from'],
  });
export type MemorizedParams = z.output<typeof memorizedParamsSchema>;
export type MemorizedParamsInput = z.input<typeof memorizedParamsSchema>;

export const memorizedReportInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter a name').max(100),
    reportKey: z.enum(REPORT_KEYS),
    params: memorizedParamsSchema,
    shared: z.boolean().default(false),
  })
  .refine((r) => r.reportKey !== 'custom' || !!r.params.definition, {
    message: 'A custom report needs its definition',
    path: ['params', 'definition'],
  });
export type MemorizedReportInput = z.input<typeof memorizedReportInputSchema>;

export const REPORT_FORMATS = ['pdf', 'xlsx', 'csv'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];
export const REPORT_FORMAT_LABELS: Record<ReportFormat, string> = {
  pdf: 'PDF',
  xlsx: 'Excel',
  csv: 'CSV',
};

export const SCHEDULE_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const email = z.email('Enter valid email addresses').max(254);

export const reportScheduleInputSchema = z.discriminatedUnion('frequency', [
  z.object({ frequency: z.literal('none') }),
  z.object({
    frequency: z.enum(SCHEDULE_FREQUENCIES),
    /** Weekly: 0 (Sunday) to 6. Monthly: 1 to 28, or 0 for the last day. Ignored daily. */
    day: z.number().int().min(0).max(28).default(1),
    hour: z.number().int().min(0).max(23),
    timezone: z.string().max(64).refine(isTimeZone, 'Choose a time zone'),
    recipients: z
      .array(email)
      .min(1, 'Add at least one recipient')
      .max(20, 'At most 20 recipients')
      .refine(
        (r) => new Set(r.map((x) => x.toLowerCase())).size === r.length,
        'A recipient is listed twice',
      ),
    format: z.enum(REPORT_FORMATS).default('pdf'),
  }),
]);
export type ReportScheduleInput = z.input<typeof reportScheduleInputSchema>;

export interface ReportScheduleDto {
  frequency: ScheduleFrequency;
  day: number;
  hour: number;
  timezone: string;
  recipients: string[];
  format: ReportFormat;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: 'sent' | 'failed' | null;
  lastError: string | null;
}

export interface MemorizedReportDto {
  id: string;
  name: string;
  reportKey: ReportKey;
  params: MemorizedParams;
  shared: boolean;
  /** Created by the person asking (only they may change it). */
  mine: boolean;
  createdByName: string;
  schedule: ReportScheduleDto | null;
  updatedAt: string;
}

/** "Every Monday at 7:00 AM (America/Chicago)". */
export function describeSchedule(s: {
  frequency: ScheduleFrequency;
  day: number;
  hour: number;
  timezone: string;
}): string {
  const h = s.hour % 12 === 0 ? 12 : s.hour % 12;
  const time = `${h}:00 ${s.hour < 12 ? 'AM' : 'PM'}`;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const when =
    s.frequency === 'daily'
      ? 'Every day'
      : s.frequency === 'weekly'
        ? `Every ${days[s.day] ?? 'Sunday'}`
        : s.day === 0
          ? 'On the last day of every month'
          : `On day ${s.day} of every month`;
  return `${when} at ${time} (${s.timezone})`;
}
