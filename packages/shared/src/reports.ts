import { z } from 'zod';
import { isIsoDate } from './dates';
import type { PayrollReportKey } from './payroll';

export const REPORT_KEYS = [
  'profit_and_loss',
  'balance_sheet',
  'trial_balance',
  'general_ledger',
  'ar_aging_summary',
  'ar_aging_detail',
  'open_invoices',
  'customer_balance_summary',
  'sales_by_customer',
  'sales_by_item',
  'ap_aging_summary',
  'ap_aging_detail',
  'unpaid_bills',
  'vendor_balance_summary',
  'expenses_by_vendor',
  'vendor_1099_summary',
  // Phase 7
  'profit_and_loss_detail',
  'balance_sheet_detail',
  'transaction_detail_by_account',
  'journal',
  'statement_of_cash_flows',
  'collections',
  'vendor_1099_detail',
  'deposit_detail',
  'check_detail',
  'missing_checks',
  'sales_tax_liability',
  'budget_overview',
  'budget_vs_actuals',
  'custom',
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

export const REPORT_TITLES: Record<ReportKey, string> = {
  profit_and_loss: 'Profit and Loss',
  balance_sheet: 'Balance Sheet',
  trial_balance: 'Trial Balance',
  general_ledger: 'General Ledger',
  ar_aging_summary: 'A/R Aging Summary',
  ar_aging_detail: 'A/R Aging Detail',
  open_invoices: 'Open Invoices',
  customer_balance_summary: 'Customer Balance Summary',
  sales_by_customer: 'Sales by Customer Summary',
  sales_by_item: 'Sales by Product/Service Summary',
  ap_aging_summary: 'A/P Aging Summary',
  ap_aging_detail: 'A/P Aging Detail',
  unpaid_bills: 'Unpaid Bills',
  vendor_balance_summary: 'Vendor Balance Summary',
  expenses_by_vendor: 'Expenses by Vendor Summary',
  vendor_1099_summary: '1099 Contractor Summary',
  profit_and_loss_detail: 'Profit and Loss Detail',
  balance_sheet_detail: 'Balance Sheet Detail',
  transaction_detail_by_account: 'Transaction Detail by Account',
  journal: 'Journal',
  statement_of_cash_flows: 'Statement of Cash Flows',
  collections: 'Collections Report',
  vendor_1099_detail: '1099 Contractor Detail',
  deposit_detail: 'Deposit Detail',
  check_detail: 'Check Detail',
  missing_checks: 'Missing Checks',
  sales_tax_liability: 'Sales Tax Liability',
  budget_overview: 'Budget Overview',
  budget_vs_actuals: 'Budget vs. Actuals',
  custom: 'Custom report',
};

/** Reports laid out like the general ledger: per account, beginning balance and transactions. */
export const LEDGER_REPORT_KEYS = [
  'general_ledger',
  'profit_and_loss_detail',
  'balance_sheet_detail',
  'transaction_detail_by_account',
] as const;
export type LedgerReportKey = (typeof LEDGER_REPORT_KEYS)[number];

/** URL segment of a report ("profit-and-loss"). */
export function reportSlug(key: ReportKey): string {
  return key.replace(/_/g, '-');
}
export function reportKeyFromSlug(slug: string): ReportKey | null {
  const key = slug.replace(/-/g, '_');
  return (REPORT_KEYS as readonly string[]).includes(key) ? (key as ReportKey) : null;
}

/** How amounts are split into columns (Profit and Loss, Balance Sheet, Budget vs. Actuals). */
export const REPORT_COLUMN_MODES = [
  'total',
  'months',
  'quarters',
  'years',
  'classes',
  'locations',
  'customers',
  'vendors',
] as const;
export type ReportColumnMode = (typeof REPORT_COLUMN_MODES)[number];
export const REPORT_COLUMN_MODE_LABELS: Record<ReportColumnMode, string> = {
  total: 'Total only',
  months: 'Months',
  quarters: 'Quarters',
  years: 'Years',
  classes: 'Classes',
  locations: 'Locations',
  customers: 'Customers',
  vendors: 'Vendors',
};

export const REPORT_COMPARISONS = ['prior_year', 'prior_period'] as const;
export type ReportComparison = (typeof REPORT_COMPARISONS)[number];
export const REPORT_COMPARISON_LABELS: Record<ReportComparison, string> = {
  prior_year: 'Previous year',
  prior_period: 'Previous period',
};

/** Most columns a report may have (months over several years, classes, …). */
export const MAX_REPORT_COLUMNS = 60;

export const ACCOUNTING_BASES_FOR_REPORTS = ['accrual', 'cash'] as const;

const isoDate = z.string().refine(isIsoDate, 'Enter a valid date');
/** An id, or "none" for amounts without one (the "Not specified" column or row). */
const idOrNone = z.union([z.uuid(), z.literal('none')]);

export const reportFiltersShape = {
  classId: idOrNone.optional(),
  locationId: idOrNone.optional(),
  accountId: z.uuid().optional(),
  customerId: idOrNone.optional(),
  vendorId: idOrNone.optional(),
  basis: z.enum(['accrual', 'cash']).optional(),
  columns: z.enum(REPORT_COLUMN_MODES).optional(),
  compare: z.enum(REPORT_COMPARISONS).optional(),
  budgetId: z.uuid().optional(),
  agencyId: z.uuid().optional(),
};

export const reportQuerySchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate,
    ...reportFiltersShape,
  })
  .refine((q) => !q.from || q.from <= q.to, {
    message: 'Start date must be on or before end date',
    path: ['from'],
  });
export type ReportQuery = z.infer<typeof reportQuerySchema>;

export type ReportRowKind = 'section' | 'account' | 'total' | 'grand_total' | 'calculated' | 'row';

/** What an amount column covers, so an account's amount in it drills to the right transactions. */
export interface ColumnDrill {
  from: string | null;
  to: string;
  classId?: string;
  locationId?: string;
  customerId?: string;
  vendorId?: string;
}

export interface ReportRow {
  kind: ReportRowKind;
  label: string;
  depth: number;
  accountId?: string;
  /** Drill-down to a customer (A/R reports). */
  customerId?: string;
  /** Drill-down to a vendor (A/P reports). */
  vendorId?: string;
  /** Drill-down to a transaction (detail reports). */
  txnId?: string;
  txnType?: string;
  /** Leading text columns for tabular reports (e.g. date, type, number). */
  cells?: Array<string | null>;
  /** One amount per column; null leaves the cell blank. Positive = normal presentation. */
  amounts: Array<string | null>;
}

export interface ReportDto {
  /** Payroll reports are served by payroll (payroll permission), not the reports hub. */
  key: Exclude<ReportKey, LedgerReportKey> | PayrollReportKey;
  /** Headers for the leading text `cells` of tabular (detail) reports. */
  textColumns?: string[];
  title: string;
  companyName: string;
  basis: 'accrual' | 'cash';
  from: string | null;
  to: string;
  columns: string[];
  rows: ReportRow[];
  /** For drill-down: the date range an account row's amount covers. */
  drillFrom: string | null;
  /** Per amount column, what an account's amount covers (null: no drill-down, e.g. % change). */
  columnDrill?: Array<ColumnDrill | null>;
  /** Amount columns that hold percentages ("% of Budget"), not money. */
  percentColumns?: number[];
  /** Shown under the report (e.g. what isn't included). */
  notes?: string[];
  /** Row limit reached; narrow the report. */
  truncated?: boolean;
  generatedAt: string;
}

export interface LedgerRowDto {
  transactionId: string;
  txnType: string;
  txnDate: string;
  number: string | null;
  name: string | null;
  description: string | null;
  split: string;
  debit: string | null;
  credit: string | null;
  balance: string;
}

export interface LedgerAccountDto {
  accountId: string;
  label: string;
  accountType: string;
  beginningBalance: string;
  rows: LedgerRowDto[];
  totalDebit: string;
  totalCredit: string;
  endingBalance: string;
}

export interface GeneralLedgerDto {
  key: LedgerReportKey;
  title: string;
  companyName: string;
  basis: 'accrual' | 'cash';
  from: string;
  to: string;
  accounts: LedgerAccountDto[];
  /** False for reports that start each account at zero (P&L Detail, Transaction Detail). */
  beginningBalances: boolean;
  truncated: boolean;
  generatedAt: string;
}
