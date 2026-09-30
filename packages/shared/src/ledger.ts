import { z } from 'zod';
import { decimalPlaces, MAX_AMOUNT, parseMoney, sumMoney, tryParseMoney } from './money';
import { isIsoDate } from './dates';

// ---------------------------------------------------------------------------------------------
// Account types (QuickBooks-compatible)
// ---------------------------------------------------------------------------------------------
export const ACCOUNT_TYPES = [
  'bank',
  'accounts_receivable',
  'other_current_asset',
  'fixed_asset',
  'other_asset',
  'accounts_payable',
  'credit_card',
  'other_current_liability',
  'long_term_liability',
  'equity',
  'income',
  'cost_of_goods_sold',
  'expense',
  'other_income',
  'other_expense',
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export type AccountCategory = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface AccountTypeInfo {
  label: string;
  category: AccountCategory;
  normalBalance: 'debit' | 'credit';
  statement: 'balance_sheet' | 'profit_and_loss';
  /** Report section the type rolls up into. */
  section: string;
  detailTypes: string[];
}

export const ACCOUNT_TYPE_INFO: Record<AccountType, AccountTypeInfo> = {
  bank: {
    label: 'Bank',
    category: 'asset',
    normalBalance: 'debit',
    statement: 'balance_sheet',
    section: 'Current Assets',
    detailTypes: ['Checking', 'Savings', 'Money Market', 'Cash on hand', 'Trust account'],
  },
  accounts_receivable: {
    label: 'Accounts receivable (A/R)',
    category: 'asset',
    normalBalance: 'debit',
    statement: 'balance_sheet',
    section: 'Current Assets',
    detailTypes: ['Accounts Receivable'],
  },
  other_current_asset: {
    label: 'Other current assets',
    category: 'asset',
    normalBalance: 'debit',
    statement: 'balance_sheet',
    section: 'Current Assets',
    detailTypes: [
      'Undeposited Funds',
      'Prepaid Expenses',
      'Inventory',
      'Employee Cash Advances',
      'Loans to Others',
      'Other Current Assets',
    ],
  },
  fixed_asset: {
    label: 'Fixed assets',
    category: 'asset',
    normalBalance: 'debit',
    statement: 'balance_sheet',
    section: 'Fixed Assets',
    detailTypes: [
      'Furniture & Fixtures',
      'Machinery & Equipment',
      'Vehicles',
      'Buildings',
      'Land',
      'Leasehold Improvements',
      'Accumulated Depreciation',
    ],
  },
  other_asset: {
    label: 'Other assets',
    category: 'asset',
    normalBalance: 'debit',
    statement: 'balance_sheet',
    section: 'Other Assets',
    detailTypes: ['Security Deposits', 'Goodwill', 'Intangible Assets', 'Other Long-term Assets'],
  },
  accounts_payable: {
    label: 'Accounts payable (A/P)',
    category: 'liability',
    normalBalance: 'credit',
    statement: 'balance_sheet',
    section: 'Current Liabilities',
    detailTypes: ['Accounts Payable'],
  },
  credit_card: {
    label: 'Credit card',
    category: 'liability',
    normalBalance: 'credit',
    statement: 'balance_sheet',
    section: 'Current Liabilities',
    detailTypes: ['Credit Card'],
  },
  other_current_liability: {
    label: 'Other current liabilities',
    category: 'liability',
    normalBalance: 'credit',
    statement: 'balance_sheet',
    section: 'Current Liabilities',
    detailTypes: [
      'Payroll Liabilities',
      'Sales Tax Payable',
      'Line of Credit',
      'Loan Payable',
      'Accrued Liabilities',
      'Other Current Liabilities',
    ],
  },
  long_term_liability: {
    label: 'Long-term liabilities',
    category: 'liability',
    normalBalance: 'credit',
    statement: 'balance_sheet',
    section: 'Long-term Liabilities',
    detailTypes: ['Notes Payable', 'Shareholder Notes Payable', 'Other Long-term Liabilities'],
  },
  equity: {
    label: 'Equity',
    category: 'equity',
    normalBalance: 'credit',
    statement: 'balance_sheet',
    section: 'Equity',
    detailTypes: [
      'Opening Balance Equity',
      'Retained Earnings',
      "Owner's Equity",
      'Partner Contributions',
      'Partner Distributions',
      'Common Stock',
      'Paid-in Capital',
      'Distributions',
      'Treasury Stock',
    ],
  },
  income: {
    label: 'Income',
    category: 'income',
    normalBalance: 'credit',
    statement: 'profit_and_loss',
    section: 'Income',
    detailTypes: [
      'Sales of Product Income',
      'Service/Fee Income',
      'Discounts/Refunds Given',
      'Other Primary Income',
    ],
  },
  cost_of_goods_sold: {
    label: 'Cost of goods sold',
    category: 'expense',
    normalBalance: 'debit',
    statement: 'profit_and_loss',
    section: 'Cost of Goods Sold',
    detailTypes: [
      'Supplies & Materials - COGS',
      'Cost of Labor - COS',
      'Shipping, Freight & Delivery - COS',
      'Other Costs of Services - COS',
    ],
  },
  expense: {
    label: 'Expenses',
    category: 'expense',
    normalBalance: 'debit',
    statement: 'profit_and_loss',
    section: 'Expenses',
    detailTypes: [
      'Advertising/Promotional',
      'Auto',
      'Bad Debts',
      'Bank Charges',
      'Dues & Subscriptions',
      'Entertainment Meals',
      'Insurance',
      'Interest Paid',
      'Legal & Professional Fees',
      'Office/General Administrative Expenses',
      'Payroll Expenses',
      'Rent or Lease of Buildings',
      'Repair & Maintenance',
      'Supplies & Materials',
      'Taxes Paid',
      'Travel',
      'Utilities',
      'Other Miscellaneous Service Cost',
    ],
  },
  other_income: {
    label: 'Other income',
    category: 'income',
    normalBalance: 'credit',
    statement: 'profit_and_loss',
    section: 'Other Income',
    detailTypes: [
      'Interest Earned',
      'Dividend Income',
      'Gain/Loss on Sale of Assets',
      'Other Miscellaneous Income',
    ],
  },
  other_expense: {
    label: 'Other expense',
    category: 'expense',
    normalBalance: 'debit',
    statement: 'profit_and_loss',
    section: 'Other Expenses',
    detailTypes: [
      'Depreciation',
      'Amortization',
      'Penalties & Settlements',
      'Exchange Gain or Loss',
      'Other Miscellaneous Expense',
    ],
  },
};

export const SYSTEM_ROLES = [
  'accounts_receivable',
  'accounts_payable',
  'undeposited_funds',
  'opening_balance_equity',
  'retained_earnings',
  'sales_tax_payable',
  'uncategorized_income',
  'uncategorized_expense',
  'uncategorized_asset',
  'payroll_liabilities',
  'payroll_expenses',
  'cost_of_goods_sold',
  'inventory_asset',
  'exchange_gain_loss',
] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

// ---------------------------------------------------------------------------------------------
// Chart of accounts: input schemas and DTOs
// ---------------------------------------------------------------------------------------------
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

const nameText = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(max)
    .refine(
      (v) => !v.includes(':'),
      'Names cannot contain ":" (it separates parent and sub-account names)',
    );

export const accountInputSchema = z.object({
  name: nameText(100),
  number: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9.-]{1,20}$/, 'Use up to 20 letters, digits, "." or "-"')
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
  accountType: z.enum(ACCOUNT_TYPES),
  detailType: optText(100),
  parentId: z.uuid().nullable().optional(),
  description: optText(1000),
});
export type AccountInput = z.input<typeof accountInputSchema>;

export const accountUpdateSchema = accountInputSchema
  .partial()
  .extend({ isActive: z.boolean().optional() });
export type AccountUpdate = z.input<typeof accountUpdateSchema>;

export interface AccountDto {
  id: string;
  number: string | null;
  name: string;
  /** "Parent:Child" path, as QuickBooks displays sub-accounts. */
  fullName: string;
  accountType: AccountType;
  detailType: string | null;
  parentId: string | null;
  depth: number;
  description: string | null;
  systemRole: SystemRole | null;
  isActive: boolean;
  /** Balance as of today for balance-sheet accounts (normal-balance sign); null for P&L accounts. */
  balance: string | null;
  hasTransactions: boolean;
  /** Foreign-currency A/R and A/P accounts (ADR 0020): the currency and the balance in it. */
  currency: string | null;
  foreignBalance: string | null;
}

// ---------------------------------------------------------------------------------------------
// Journal entries
// ---------------------------------------------------------------------------------------------
const amountText = z
  .string()
  .trim()
  .transform((v) => v.replace(/[$,\s]/g, ''))
  .refine((v) => v === '' || tryParseMoney(v) !== null, 'Enter a valid amount')
  .refine((v) => v === '' || decimalPlaces(v) <= 2, 'Amounts can have at most 2 decimal places')
  .refine(
    (v) => v === '' || parseMoney(v) >= 0n,
    'Enter a positive amount; use the other column for the opposite side',
  )
  .refine((v) => v === '' || parseMoney(v) <= MAX_AMOUNT, 'Amount is too large')
  .optional();

export const journalLineInputSchema = z.object({
  accountId: z.uuid('Choose an account'),
  debit: amountText,
  credit: amountText,
  description: optText(4000),
  customerId: z.uuid().nullable().optional(),
  vendorId: z.uuid().nullable().optional(),
  classId: z.uuid().nullable().optional(),
  locationId: z.uuid().nullable().optional(),
});
export type JournalLineInput = z.input<typeof journalLineInputSchema>;

const lineAmount = (v: string | undefined) => (v ? parseMoney(v) : 0n);

export const journalEntryInputSchema = z
  .object({
    txnDate: z.string().refine(isIsoDate, 'Enter a valid date'),
    number: optText(30),
    memo: optText(4000),
    isAdjusting: z.boolean().default(false),
    lines: z.array(journalLineInputSchema).max(1000),
    /** Required only when the date falls on or before the company's closing date. */
    closingPassword: z.string().max(128).optional(),
    /** Optimistic concurrency: required for updates, the version the user edited. */
    version: z.number().int().min(1).optional(),
  })
  .superRefine((je, ctx) => {
    je.lines.forEach((l, i) => {
      const d = lineAmount(l.debit);
      const c = lineAmount(l.credit);
      if (d > 0n && c > 0n) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines', i, 'credit'],
          message: 'A line can have a debit or a credit, not both',
        });
      }
      if (d === 0n && c === 0n) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines', i, 'debit'],
          message: 'Enter a debit or credit amount',
        });
      }
      if (l.customerId && l.vendorId) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines', i, 'vendorId'],
          message: 'Choose either a customer or a vendor',
        });
      }
    });
    if (je.lines.length < 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines'],
        message: 'A journal entry needs at least two lines',
      });
      return;
    }
    const debits = sumMoney(je.lines.map((l) => lineAmount(l.debit)));
    const credits = sumMoney(je.lines.map((l) => lineAmount(l.credit)));
    if (debits !== credits) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines'],
        message: 'Debits and credits must be equal',
      });
    }
  });
export type JournalEntryInput = z.input<typeof journalEntryInputSchema>;

export const reverseEntrySchema = z.object({
  txnDate: z.string().refine(isIsoDate, 'Enter a valid date'),
  closingPassword: z.string().max(128).optional(),
});

export const closingPasswordSchema = z.object({ closingPassword: z.string().max(128).optional() });

export interface JournalLineDto {
  lineNo: number;
  accountId: string;
  accountName: string;
  debit: string | null;
  credit: string | null;
  description: string | null;
  customerId: string | null;
  vendorId: string | null;
  name: string | null;
  classId: string | null;
  locationId: string | null;
}

export type TransactionStatus = 'posted' | 'void' | 'deleted';

export interface JournalEntryDto {
  id: string;
  txnType: 'journal_entry';
  txnDate: string;
  number: string | null;
  memo: string | null;
  status: TransactionStatus;
  version: number;
  isAdjusting: boolean;
  reversalOfId: string | null;
  total: string;
  lines: JournalLineDto[];
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface JournalEntrySummaryDto {
  id: string;
  txnDate: string;
  number: string | null;
  memo: string | null;
  status: TransactionStatus;
  isAdjusting: boolean;
  total: string;
  accounts: string[];
}

export interface JournalEntryPageDto {
  entries: JournalEntrySummaryDto[];
  nextCursor: string | null;
}

export const journalListQuerySchema = z.object({
  from: z.string().refine(isIsoDate).optional(),
  to: z.string().refine(isIsoDate).optional(),
  search: z.string().trim().max(100).optional(),
  includeVoid: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type JournalListQuery = z.infer<typeof journalListQuerySchema>;

// ---------------------------------------------------------------------------------------------
// Ledger settings (closing date, account numbers)
// ---------------------------------------------------------------------------------------------
export const ledgerSettingsSchema = z.object({
  useAccountNumbers: z.boolean().optional(),
  closingDate: z.string().refine(isIsoDate, 'Enter a valid date').nullable().optional(),
  /** New closing-date password; omit to keep, '' to remove. */
  closingPassword: z.string().max(128).optional(),
  /** Current password, required to change or remove an existing closing date/password. */
  currentClosingPassword: z.string().max(128).optional(),
  /** How inventory is costed (ADR 0018). Can't change once inventory has moved. */
  inventoryCosting: z.enum(['fifo', 'average']).optional(),
});
export type LedgerSettingsInput = z.input<typeof ledgerSettingsSchema>;

export interface LedgerSettingsDto {
  useAccountNumbers: boolean;
  closingDate: string | null;
  hasClosingPassword: boolean;
  inventoryCosting: 'fifo' | 'average';
  /** True once any inventory has moved: the costing method is then fixed. */
  inventoryCostingLocked: boolean;
}
