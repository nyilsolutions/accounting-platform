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
    key: 'import',
    label: 'Import from QuickBooks',
    path: '/import',
    shortcut: 'i',
    permission: 'company.settings.manage',
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
  banking: {
    title: 'Banking',
    phase: 'Phase 4',
    features: [
      'Bank and credit card registers',
      'Import QBO / QFX / OFX / CSV files',
      'Live bank feeds (Plaid)',
      'Bank rules and matching',
      'Reconciliation with reports',
    ],
  },
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
  documents: {
    title: 'Documents',
    phase: 'Phase 5',
    features: [
      'Attach files to any transaction',
      'Receipt capture with OCR',
      'Email-in inbox',
      'Document library with search',
    ],
  },
  import: {
    title: 'Import from QuickBooks',
    phase: 'Phase 6',
    features: [
      'QuickBooks Online connection (including attachments)',
      'QuickBooks Desktop migration agent',
      'IIF and Excel/CSV import',
      'Automated tie-out report',
    ],
  },
};
