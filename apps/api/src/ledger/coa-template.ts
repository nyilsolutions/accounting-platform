import type { AccountType, SystemRole, TaxForm } from '@acct/shared';

export interface TemplateAccount {
  name: string;
  number: string;
  type: AccountType;
  detailType: string;
  systemRole?: SystemRole;
  children?: TemplateAccount[];
}

/**
 * Default chart of accounts for a new small business. Numbers follow the common
 * 1xxx assets / 2xxx liabilities / 3xxx equity / 4xxx income / 5xxx COGS / 6xxx expenses /
 * 7xxx other income / 8xxx other expense convention (shown only when account numbers are on).
 * Equity accounts vary by the company's income tax form.
 */
const COMMON_BEFORE_EQUITY: TemplateAccount[] = [
  { name: 'Checking', number: '1000', type: 'bank', detailType: 'Checking' },
  { name: 'Savings', number: '1010', type: 'bank', detailType: 'Savings' },
  {
    name: 'Accounts Receivable (A/R)',
    number: '1200',
    type: 'accounts_receivable',
    detailType: 'Accounts Receivable',
    systemRole: 'accounts_receivable',
  },
  {
    name: 'Undeposited Funds',
    number: '1300',
    type: 'other_current_asset',
    detailType: 'Undeposited Funds',
    systemRole: 'undeposited_funds',
  },
  {
    name: 'Prepaid Expenses',
    number: '1400',
    type: 'other_current_asset',
    detailType: 'Prepaid Expenses',
  },
  {
    name: 'Uncategorized Asset',
    number: '1499',
    type: 'other_current_asset',
    detailType: 'Other Current Assets',
    systemRole: 'uncategorized_asset',
  },
  {
    name: 'Furniture and Equipment',
    number: '1500',
    type: 'fixed_asset',
    detailType: 'Furniture & Fixtures',
  },
  { name: 'Vehicles', number: '1510', type: 'fixed_asset', detailType: 'Vehicles' },
  {
    name: 'Accumulated Depreciation',
    number: '1590',
    type: 'fixed_asset',
    detailType: 'Accumulated Depreciation',
  },
  {
    name: 'Security Deposits',
    number: '1800',
    type: 'other_asset',
    detailType: 'Security Deposits',
  },
  {
    name: 'Accounts Payable (A/P)',
    number: '2000',
    type: 'accounts_payable',
    detailType: 'Accounts Payable',
    systemRole: 'accounts_payable',
  },
  { name: 'Credit Card', number: '2100', type: 'credit_card', detailType: 'Credit Card' },
  {
    name: 'Payroll Liabilities',
    number: '2200',
    type: 'other_current_liability',
    detailType: 'Payroll Liabilities',
    systemRole: 'payroll_liabilities',
  },
  {
    name: 'Sales Tax Payable',
    number: '2300',
    type: 'other_current_liability',
    detailType: 'Sales Tax Payable',
    systemRole: 'sales_tax_payable',
  },
  {
    name: 'Loans Payable',
    number: '2700',
    type: 'long_term_liability',
    detailType: 'Notes Payable',
  },
  {
    name: 'Opening Balance Equity',
    number: '3000',
    type: 'equity',
    detailType: 'Opening Balance Equity',
    systemRole: 'opening_balance_equity',
  },
  {
    name: 'Retained Earnings',
    number: '3900',
    type: 'equity',
    detailType: 'Retained Earnings',
    systemRole: 'retained_earnings',
  },
];

const EQUITY_BY_TAX_FORM: Record<TaxForm, TemplateAccount[]> = {
  schedule_c: [
    { name: "Owner's Investment", number: '3100', type: 'equity', detailType: "Owner's Equity" },
    { name: "Owner's Draw", number: '3200', type: 'equity', detailType: "Owner's Equity" },
  ],
  form_1065: [
    {
      name: 'Partner Contributions',
      number: '3100',
      type: 'equity',
      detailType: 'Partner Contributions',
    },
    {
      name: 'Partner Distributions',
      number: '3200',
      type: 'equity',
      detailType: 'Partner Distributions',
    },
  ],
  form_1120: [
    { name: 'Common Stock', number: '3100', type: 'equity', detailType: 'Common Stock' },
    {
      name: 'Additional Paid-in Capital',
      number: '3150',
      type: 'equity',
      detailType: 'Paid-in Capital',
    },
    { name: 'Dividends Paid', number: '3200', type: 'equity', detailType: 'Distributions' },
  ],
  form_1120s: [
    { name: 'Common Stock', number: '3100', type: 'equity', detailType: 'Common Stock' },
    {
      name: 'Additional Paid-in Capital',
      number: '3150',
      type: 'equity',
      detailType: 'Paid-in Capital',
    },
    {
      name: 'Shareholder Distributions',
      number: '3200',
      type: 'equity',
      detailType: 'Distributions',
    },
  ],
  form_990: [
    {
      name: 'Net Assets Without Donor Restrictions',
      number: '3100',
      type: 'equity',
      detailType: 'Retained Earnings',
    },
  ],
  other: [
    { name: "Owner's Investment", number: '3100', type: 'equity', detailType: "Owner's Equity" },
    { name: "Owner's Draw", number: '3200', type: 'equity', detailType: "Owner's Equity" },
  ],
};

const COMMON_AFTER_EQUITY: TemplateAccount[] = [
  { name: 'Sales', number: '4000', type: 'income', detailType: 'Sales of Product Income' },
  { name: 'Services', number: '4100', type: 'income', detailType: 'Service/Fee Income' },
  {
    name: 'Discounts Given',
    number: '4900',
    type: 'income',
    detailType: 'Discounts/Refunds Given',
  },
  {
    name: 'Uncategorized Income',
    number: '4999',
    type: 'income',
    detailType: 'Other Primary Income',
    systemRole: 'uncategorized_income',
  },
  {
    name: 'Cost of Goods Sold',
    number: '5000',
    type: 'cost_of_goods_sold',
    detailType: 'Supplies & Materials - COGS',
    systemRole: 'cost_of_goods_sold',
  },
  {
    name: 'Subcontractors',
    number: '5100',
    type: 'cost_of_goods_sold',
    detailType: 'Cost of Labor - COS',
  },
  {
    name: 'Advertising and Marketing',
    number: '6000',
    type: 'expense',
    detailType: 'Advertising/Promotional',
  },
  { name: 'Bank Charges and Fees', number: '6100', type: 'expense', detailType: 'Bank Charges' },
  { name: 'Car and Truck', number: '6150', type: 'expense', detailType: 'Auto' },
  {
    name: 'Contract Labor',
    number: '6200',
    type: 'expense',
    detailType: 'Other Miscellaneous Service Cost',
  },
  {
    name: 'Dues and Subscriptions',
    number: '6250',
    type: 'expense',
    detailType: 'Dues & Subscriptions',
  },
  { name: 'Insurance', number: '6300', type: 'expense', detailType: 'Insurance' },
  { name: 'Interest Paid', number: '6350', type: 'expense', detailType: 'Interest Paid' },
  {
    name: 'Legal and Professional Fees',
    number: '6400',
    type: 'expense',
    detailType: 'Legal & Professional Fees',
  },
  { name: 'Meals', number: '6450', type: 'expense', detailType: 'Entertainment Meals' },
  {
    name: 'Office Supplies and Software',
    number: '6500',
    type: 'expense',
    detailType: 'Office/General Administrative Expenses',
  },
  {
    name: 'Payroll Expenses',
    number: '6600',
    type: 'expense',
    detailType: 'Payroll Expenses',
    systemRole: 'payroll_expenses',
    children: [
      { name: 'Wages', number: '6610', type: 'expense', detailType: 'Payroll Expenses' },
      { name: 'Payroll Taxes', number: '6620', type: 'expense', detailType: 'Payroll Expenses' },
    ],
  },
  {
    name: 'Rent and Lease',
    number: '6700',
    type: 'expense',
    detailType: 'Rent or Lease of Buildings',
  },
  {
    name: 'Repairs and Maintenance',
    number: '6750',
    type: 'expense',
    detailType: 'Repair & Maintenance',
  },
  { name: 'Taxes and Licenses', number: '6800', type: 'expense', detailType: 'Taxes Paid' },
  { name: 'Travel', number: '6850', type: 'expense', detailType: 'Travel' },
  { name: 'Utilities', number: '6900', type: 'expense', detailType: 'Utilities' },
  {
    name: 'Uncategorized Expense',
    number: '6999',
    type: 'expense',
    detailType: 'Other Miscellaneous Service Cost',
    systemRole: 'uncategorized_expense',
  },
  { name: 'Interest Earned', number: '7000', type: 'other_income', detailType: 'Interest Earned' },
  { name: 'Depreciation', number: '8000', type: 'other_expense', detailType: 'Depreciation' },
  {
    name: 'Penalties and Settlements',
    number: '8100',
    type: 'other_expense',
    detailType: 'Penalties & Settlements',
  },
];

export function defaultChartOfAccounts(taxForm: TaxForm): TemplateAccount[] {
  return [...COMMON_BEFORE_EQUITY, ...EQUITY_BY_TAX_FORM[taxForm], ...COMMON_AFTER_EQUITY];
}

export const DEFAULT_TERMS = [
  { name: 'Due on receipt', due_days: 0, discount_percent: '0', discount_days: 0 },
  { name: 'Net 15', due_days: 15, discount_percent: '0', discount_days: 0 },
  { name: 'Net 30', due_days: 30, discount_percent: '0', discount_days: 0 },
  { name: 'Net 60', due_days: 60, discount_percent: '0', discount_days: 0 },
  { name: '1% 10 Net 30', due_days: 30, discount_percent: '1', discount_days: 10 },
];

export const DEFAULT_PAYMENT_METHODS = ['Cash', 'Check', 'Credit card', 'ACH / bank transfer'];
