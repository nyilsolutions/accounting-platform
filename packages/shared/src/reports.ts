import { z } from 'zod';
import { isIsoDate } from './dates';

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
};

export const ACCOUNTING_BASES_FOR_REPORTS = ['accrual', 'cash'] as const;

const isoDate = z.string().refine(isIsoDate, 'Enter a valid date');

export const reportQuerySchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate,
    classId: z.uuid().optional(),
    locationId: z.uuid().optional(),
    accountId: z.uuid().optional(),
    customerId: z.uuid().optional(),
    basis: z.enum(['accrual', 'cash']).optional(),
  })
  .refine((q) => !q.from || q.from <= q.to, {
    message: 'Start date must be on or before end date',
    path: ['from'],
  });
export type ReportQuery = z.infer<typeof reportQuerySchema>;

export type ReportRowKind = 'section' | 'account' | 'total' | 'grand_total' | 'calculated' | 'row';

export interface ReportRow {
  kind: ReportRowKind;
  label: string;
  depth: number;
  accountId?: string;
  /** Drill-down to a customer (A/R reports). */
  customerId?: string;
  /** Drill-down to a transaction (detail reports). */
  txnId?: string;
  txnType?: string;
  /** Leading text columns for tabular reports (e.g. date, type, number). */
  cells?: Array<string | null>;
  /** One amount per column; null leaves the cell blank. Positive = normal presentation. */
  amounts: Array<string | null>;
}

export interface ReportDto {
  key: Exclude<ReportKey, 'general_ledger'>;
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
  key: 'general_ledger';
  title: string;
  companyName: string;
  basis: 'accrual' | 'cash';
  from: string;
  to: string;
  accounts: LedgerAccountDto[];
  truncated: boolean;
  generatedAt: string;
}
