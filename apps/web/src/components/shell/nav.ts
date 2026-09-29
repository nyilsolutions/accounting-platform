import type { Permission } from '@acct/shared';

export interface NavItem {
  key: string;
  label: string;
  /** Path relative to /c/:companyId */
  path: string;
  /** Second key of the "g <key>" navigation shortcut. */
  shortcut?: string;
  permission?: Permission;
  /** 'hidden' items are reachable by shortcut and command palette only. */
  section: 'main' | 'settings' | 'hidden';
}

export const NAV: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', path: '', shortcut: 'd', section: 'main' },
  {
    key: 'sales',
    label: 'Sales & customers',
    path: '/sales',
    shortcut: 's',
    permission: 'sales.view',
    section: 'main',
  },
  {
    key: 'expenses',
    label: 'Expenses & vendors',
    path: '/expenses',
    shortcut: 'e',
    permission: 'purchases.view',
    section: 'main',
  },
  {
    key: 'banking',
    label: 'Banking',
    path: '/banking',
    shortcut: 'b',
    permission: 'banking.view',
    section: 'main',
  },
  {
    key: 'payroll',
    label: 'Payroll',
    path: '/payroll',
    shortcut: 'p',
    permission: 'payroll.view',
    section: 'main',
  },
  {
    key: 'reports',
    label: 'Reports',
    path: '/reports',
    shortcut: 'r',
    permission: 'reports.view',
    section: 'main',
  },
  {
    key: 'accounting',
    label: 'Accounting',
    path: '/accounting',
    shortcut: 'a',
    permission: 'ledger.view',
    section: 'main',
  },
  {
    key: 'journal',
    label: 'New journal entry',
    path: '/accounting/journal-entries/new',
    shortcut: 'j',
    permission: 'ledger.manage',
    section: 'hidden',
  },
  {
    key: 'new-invoice',
    label: 'New invoice',
    path: '/sales/invoices/new',
    shortcut: 'n',
    permission: 'sales.manage',
    section: 'hidden',
  },
  {
    key: 'receive-payment',
    label: 'Receive payment',
    path: '/sales/payments/new',
    shortcut: 'y',
    permission: 'sales.manage',
    section: 'hidden',
  },
  {
    key: 'new-estimate',
    label: 'New estimate',
    path: '/sales/estimates/new',
    permission: 'sales.manage',
    section: 'hidden',
  },
  {
    key: 'new-sales-receipt',
    label: 'New sales receipt',
    path: '/sales/sales-receipts/new',
    permission: 'sales.manage',
    section: 'hidden',
  },
  {
    key: 'new-credit-memo',
    label: 'New credit memo',
    path: '/sales/credit-memos/new',
    permission: 'sales.manage',
    section: 'hidden',
  },
  {
    key: 'bank-deposit',
    label: 'Bank deposit',
    path: '/sales/deposits/new',
    shortcut: 'k',
    permission: 'banking.manage',
    section: 'hidden',
  },
  {
    key: 'transfer',
    label: 'Transfer (or pay a credit card)',
    path: '/banking/transfers/new',
    shortcut: 'f',
    permission: 'banking.manage',
    section: 'hidden',
  },
  {
    key: 'reconcile',
    label: 'Reconcile',
    path: '/banking/reconcile',
    shortcut: 'z',
    permission: 'banking.manage',
    section: 'hidden',
  },
  {
    key: 'bank-rules',
    label: 'Bank rules',
    path: '/banking/rules',
    permission: 'banking.view',
    section: 'hidden',
  },
  {
    key: 'upload-transactions',
    label: 'Upload bank transactions',
    path: '/banking/import',
    permission: 'banking.manage',
    section: 'hidden',
  },
  {
    key: 'new-bill',
    label: 'New bill',
    path: '/expenses/bills/new',
    shortcut: 'm',
    permission: 'purchases.manage',
    section: 'hidden',
  },
  {
    key: 'pay-bills',
    label: 'Pay bills',
    path: '/expenses/pay-bills',
    shortcut: 'v',
    permission: 'purchases.manage',
    section: 'hidden',
  },
  {
    key: 'new-expense',
    label: 'New expense',
    path: '/expenses/expenses/new',
    shortcut: 'x',
    permission: 'purchases.manage',
    section: 'hidden',
  },
  {
    key: 'write-check',
    label: 'Write check',
    path: '/expenses/checks/new',
    shortcut: 'w',
    permission: 'purchases.manage',
    section: 'hidden',
  },
  {
    key: 'print-checks',
    label: 'Print checks',
    path: '/expenses/print-checks',
    permission: 'purchases.manage',
    section: 'hidden',
  },
  {
    key: 'new-purchase-order',
    label: 'New purchase order',
    path: '/expenses/purchase-orders/new',
    permission: 'purchases.manage',
    section: 'hidden',
  },
  {
    key: 'vendors',
    label: 'Vendors',
    path: '/expenses/vendors',
    permission: 'purchases.view',
    section: 'hidden',
  },
  {
    key: 'customers',
    label: 'Customers',
    path: '/sales/customers',
    permission: 'sales.view',
    section: 'hidden',
  },
  {
    key: 'documents',
    label: 'Documents',
    path: '/documents',
    shortcut: 'o',
    permission: 'documents.view',
    section: 'main',
  },
  {
    key: 'receipts-inbox',
    label: 'Receipts inbox',
    path: '/documents/inbox',
    shortcut: 'q',
    permission: 'documents.view',
    section: 'hidden',
  },
  {
    key: 'import',
    label: 'Import from QuickBooks',
    path: '/import',
    shortcut: 'i',
    permission: 'migration.manage',
    section: 'main',
  },
  {
    key: 'company',
    label: 'Company settings',
    path: '/settings',
    shortcut: 'c',
    permission: 'company.view',
    section: 'settings',
  },
  {
    key: 'lists',
    label: 'Lists',
    path: '/settings/lists',
    shortcut: 't',
    permission: 'company.view',
    section: 'settings',
  },
  {
    key: 'users',
    label: 'Users & roles',
    path: '/settings/users',
    shortcut: 'u',
    permission: 'users.view',
    section: 'settings',
  },
  {
    key: 'audit',
    label: 'Audit log',
    path: '/settings/audit-log',
    shortcut: 'l',
    permission: 'audit.view',
    section: 'settings',
  },
];

/** Placeholder content for modules delivered in later phases (see CLAUDE.md phase plan). */
export const UPCOMING_MODULES: Record<
  string,
  { title: string; phase: string; features: string[] }
> = {
  payroll: {
    title: 'Payroll',
    phase: 'Phases 8–9',
    features: [
      'Employees, W-4 and pay schedules',
      'Pay runs with federal and state withholding',
      'Direct deposit (NACHA)',
      'Tax liabilities and deposits',
      'Forms 941, 940, W-2/W-3, 1099-NEC/MISC',
    ],
  },
};
