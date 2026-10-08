import type { DatePreset, Permission, ReportColumnMode } from '@acct/shared';

/** What a report's settings bar offers. */
export interface ReportConfig {
  title: string;
  description: string;
  /** "As of" one date instead of a period. */
  pointInTime: boolean;
  defaultPreset: DatePreset;
  /** Accrual / cash toggle. */
  basis?: boolean;
  /** Class and location filters. */
  classes?: boolean;
  customer?: boolean;
  vendor?: boolean;
  /** "Display columns by" choices beyond the total. */
  columns?: ReportColumnMode[];
  compare?: boolean;
  budget?: boolean;
  /** The dates come from the budget. */
  datesFromBudget?: boolean;
  agency?: boolean;
  account?: 'any' | 'bank';
}

export interface CatalogGroup {
  title: string;
  reports: Array<{ slug: string } & ReportConfig>;
  /** Pages that aren't standard reports (builder, budgets, audit log). */
  links?: Array<{ href: string; title: string; description: string; permission?: Permission }>;
}

const DIMS: ReportColumnMode[] = ['classes', 'locations', 'customers', 'vendors'];
const PERIODS: ReportColumnMode[] = ['months', 'quarters', 'years'];

export const CATALOG: CatalogGroup[] = [
  {
    title: 'Business overview',
    reports: [
      {
        slug: 'profit-and-loss',
        title: 'Profit and Loss',
        description:
          'Income and expenses for a period, and your net income. By month, class, customer…, or compared with last year.',
        pointInTime: false,
        defaultPreset: 'this_fiscal_year_to_date',
        basis: true,
        classes: true,
        customer: true,
        vendor: true,
        columns: [...PERIODS, ...DIMS],
        compare: true,
      },
      {
        slug: 'balance-sheet',
        title: 'Balance Sheet',
        description: 'What you own, what you owe and your equity on a date, or at each month end.',
        pointInTime: true,
        defaultPreset: 'this_fiscal_year_to_date',
        basis: true,
        columns: PERIODS,
        compare: true,
      },
      {
        slug: 'statement-of-cash-flows',
        title: 'Statement of Cash Flows',
        description: 'Where cash came from and went: operating, investing and financing.',
        pointInTime: false,
        defaultPreset: 'this_fiscal_year_to_date',
      },
      {
        slug: 'profit-and-loss-detail',
        title: 'Profit and Loss Detail',
        description: 'Every income and expense transaction behind the Profit and Loss.',
        pointInTime: false,
        defaultPreset: 'this_month',
        classes: true,
        customer: true,
        vendor: true,
      },
      {
        slug: 'balance-sheet-detail',
        title: 'Balance Sheet Detail',
        description: 'Balance sheet accounts with their beginning balances and transactions.',
        pointInTime: false,
        defaultPreset: 'this_month',
        classes: true,
      },
      {
        slug: 'budget-vs-actuals',
        title: 'Budget vs. Actuals',
        description: 'Actual income and expenses against a budget, in total or by month.',
        pointInTime: false,
        defaultPreset: 'this_fiscal_year_to_date',
        basis: true,
        classes: true,
        customer: true,
        budget: true,
        columns: ['months'],
      },
      {
        slug: 'budget-overview',
        title: 'Budget Overview',
        description: 'A budget by account and month.',
        pointInTime: false,
        defaultPreset: 'this_fiscal_year',
        classes: true,
        customer: true,
        budget: true,
        datesFromBudget: true,
      },
    ],
    links: [
      {
        href: '/reports/budgets',
        title: 'Budgets',
        description: 'Plan income and expenses by month, by account, class, location or customer.',
      },
    ],
  },
  {
    title: 'Who owes you',
    reports: [
      {
        slug: 'ar-aging-summary',
        title: 'A/R Aging Summary',
        description: 'Unpaid balances per customer, by how long they are overdue.',
        pointInTime: true,
        defaultPreset: 'today',
        customer: true,
      },
      {
        slug: 'ar-aging-detail',
        title: 'A/R Aging Detail',
        description: 'Every open invoice, credit and payment, grouped by days past due.',
        pointInTime: true,
        defaultPreset: 'today',
        customer: true,
      },
      {
        slug: 'open-invoices',
        title: 'Open Invoices',
        description: 'Unpaid invoices and unused credits by customer.',
        pointInTime: true,
        defaultPreset: 'today',
        customer: true,
      },
      {
        slug: 'collections',
        title: 'Collections Report',
        description: 'Overdue invoices by customer, with their email and phone.',
        pointInTime: true,
        defaultPreset: 'today',
        customer: true,
      },
      {
        slug: 'customer-balance-summary',
        title: 'Customer Balance Summary',
        description: 'What each customer owes on a date.',
        pointInTime: true,
        defaultPreset: 'today',
        customer: true,
      },
    ],
  },
  {
    title: 'Sales and customers',
    reports: [
      {
        slug: 'sales-by-customer',
        title: 'Sales by Customer Summary',
        description: 'Net sales per customer for a period.',
        pointInTime: false,
        defaultPreset: 'this_fiscal_year_to_date',
        classes: true,
        customer: true,
      },
      {
        slug: 'sales-by-item',
        title: 'Sales by Product/Service Summary',
        description: 'Quantity, amount and average price per product or service.',
        pointInTime: false,
        defaultPreset: 'this_fiscal_year_to_date',
        classes: true,
        customer: true,
      },
    ],
  },
  {
    title: 'What you owe',
    reports: [
      {
        slug: 'ap-aging-summary',
        title: 'A/P Aging Summary',
        description: 'Unpaid bills per vendor, by how long they are overdue.',
        pointInTime: true,
        defaultPreset: 'today',
        vendor: true,
      },
      {
        slug: 'ap-aging-detail',
        title: 'A/P Aging Detail',
        description: 'Every unpaid bill and vendor credit, grouped by days past due.',
        pointInTime: true,
        defaultPreset: 'today',
        vendor: true,
      },
      {
        slug: 'unpaid-bills',
        title: 'Unpaid Bills',
        description: 'Open bills and unused vendor credits by vendor.',
        pointInTime: true,
        defaultPreset: 'today',
        vendor: true,
      },
      {
        slug: 'vendor-balance-summary',
        title: 'Vendor Balance Summary',
        description: 'What you owe each vendor on a date.',
        pointInTime: true,
        defaultPreset: 'today',
        vendor: true,
      },
    ],
  },
  {
    title: 'Expenses and vendors',
    reports: [
      {
        slug: 'expenses-by-vendor',
        title: 'Expenses by Vendor Summary',
        description: 'Spending per vendor for a period.',
        pointInTime: false,
        defaultPreset: 'this_fiscal_year_to_date',
        classes: true,
        vendor: true,
      },
      {
        slug: 'vendor-1099-summary',
        title: '1099 Contractor Summary',
        description:
          'Payments to 1099 vendors per box for a calendar year, against the thresholds.',
        pointInTime: true,
        defaultPreset: 'today',
      },
      {
        slug: 'vendor-1099-detail',
        title: '1099 Contractor Detail',
        description: 'Every payment that counts toward a contractor’s 1099.',
        pointInTime: true,
        defaultPreset: 'today',
        vendor: true,
      },
    ],
  },
  {
    title: 'Inventory',
    reports: [
      {
        slug: 'inventory-valuation-summary',
        title: 'Inventory Valuation Summary',
        description: 'Quantity on hand, average cost, asset value and retail value of each item.',
        pointInTime: true,
        defaultPreset: 'today',
      },
      {
        slug: 'inventory-valuation-detail',
        title: 'Inventory Valuation Detail',
        description:
          'Every purchase, sale, adjustment and build of each item, with its cost and running value.',
        pointInTime: false,
        defaultPreset: 'this_month',
      },
      {
        slug: 'inventory-stock-status',
        title: 'Inventory Stock Status by Item',
        description: 'On hand and on order against reorder points, flagging what to reorder.',
        pointInTime: true,
        defaultPreset: 'today',
      },
    ],
  },
  {
    title: 'Banking',
    reports: [
      {
        slug: 'deposit-detail',
        title: 'Deposit Detail',
        description: 'Bank deposits and the payments and receipts in each.',
        pointInTime: false,
        defaultPreset: 'this_month',
        account: 'bank',
      },
      {
        slug: 'check-detail',
        title: 'Check Detail',
        description: 'Checks and bill payments from your bank accounts, with what they paid for.',
        pointInTime: false,
        defaultPreset: 'this_month',
        account: 'bank',
      },
      {
        slug: 'missing-checks',
        title: 'Missing Checks',
        description: 'Checks in number order, flagging gaps and numbers used twice.',
        pointInTime: false,
        defaultPreset: 'this_fiscal_year_to_date',
        account: 'bank',
      },
    ],
  },
  {
    title: 'Sales tax',
    reports: [
      {
        slug: 'sales-tax-liability',
        title: 'Sales Tax Liability',
        description: 'Taxable sales, tax charged, payments and what you owe each agency.',
        pointInTime: false,
        defaultPreset: 'last_fiscal_quarter',
        agency: true,
      },
    ],
  },
  {
    title: 'For my accountant',
    reports: [
      {
        slug: 'trial-balance',
        title: 'Trial Balance',
        description: 'Debit and credit balances of every account; used to check the books.',
        pointInTime: true,
        defaultPreset: 'this_fiscal_year_to_date',
        basis: true,
      },
      {
        slug: 'general-ledger',
        title: 'General Ledger',
        description: 'Every transaction by account with running balances.',
        pointInTime: false,
        defaultPreset: 'this_month',
        classes: true,
        customer: true,
        vendor: true,
        account: 'any',
      },
      {
        slug: 'transaction-detail-by-account',
        title: 'Transaction Detail by Account',
        description: 'Transactions by account for a period, starting from zero.',
        pointInTime: false,
        defaultPreset: 'this_month',
        classes: true,
        customer: true,
        vendor: true,
        account: 'any',
      },
      {
        slug: 'journal',
        title: 'Journal',
        description: 'Every transaction with its debits and credits, in date order.',
        pointInTime: false,
        defaultPreset: 'this_month',
        account: 'any',
      },
    ],
    links: [
      {
        href: '/reports/custom',
        title: 'Custom report',
        description: 'Choose columns, filters, grouping and subtotals over every transaction.',
      },
      {
        href: '/settings/audit-log',
        title: 'Audit Log',
        description: 'Who changed what and when, with before and after values.',
        permission: 'audit.view',
      },
    ],
  },
];

export const REPORT_CONFIG: Record<string, ReportConfig> = Object.fromEntries(
  CATALOG.flatMap((g) => g.reports.map((r) => [r.slug, r])),
);
