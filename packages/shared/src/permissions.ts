/**
 * Permissions are the unit of authorization. Roles are named bundles of permissions.
 * The API enforces permissions; the web app only uses them to hide UI it cannot use.
 *
 * Module permissions for later phases (sales, purchases, banking, payroll, ...) are
 * declared now so role definitions stay stable as modules ship.
 */
export const PERMISSIONS = [
  'company.view',
  'company.settings.manage',
  'company.sensitive.reveal',
  'users.view',
  'users.manage',
  'audit.view',
  'ledger.view',
  'ledger.manage',
  'sales.view',
  'sales.manage',
  'purchases.view',
  'purchases.manage',
  'banking.view',
  'banking.manage',
  'payroll.view',
  'payroll.manage',
  /** See employees' full SSNs (always audit-logged). */
  'payroll.sensitive.reveal',
  'reports.view',
  'time.manage',
  'documents.view',
  'documents.manage',
  'migration.manage',
  'sales_tax.manage',
  'budgets.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = [
  'owner',
  'admin',
  'accountant',
  'standard',
  'sales',
  'purchases',
  'payroll_admin',
  'time_tracking',
  'reports_only',
] as const;

export type Role = (typeof ROLES)[number];

const ALL: readonly Permission[] = PERMISSIONS;

const TRANSACTIONS: readonly Permission[] = [
  'company.view',
  'ledger.view',
  'sales.view',
  'sales.manage',
  'purchases.view',
  'purchases.manage',
  'banking.view',
  'banking.manage',
  'time.manage',
  'documents.view',
  'documents.manage',
  'reports.view',
  'sales_tax.manage',
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ALL,
  admin: ALL,
  // External accountant: full books access, can see users but not manage them.
  accountant: ALL.filter((p) => p !== 'users.manage'),
  standard: TRANSACTIONS,
  sales: ['company.view', 'sales.view', 'sales.manage', 'documents.view', 'documents.manage'],
  purchases: [
    'company.view',
    'purchases.view',
    'purchases.manage',
    'documents.view',
    'documents.manage',
  ],
  payroll_admin: [
    'company.view',
    'payroll.view',
    'payroll.manage',
    'payroll.sensitive.reveal',
    'documents.view',
    'documents.manage',
  ],
  time_tracking: ['company.view', 'time.manage'],
  reports_only: ['company.view', 'reports.view'],
};

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  accountant: 'Accountant',
  standard: 'Standard (all transactions)',
  sales: 'Sales only',
  purchases: 'Purchases only',
  payroll_admin: 'Payroll admin',
  time_tracking: 'Time tracking only',
  reports_only: 'Reports only',
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Only owners may grant or revoke the owner role. */
export function canAssignRole(actorRole: Role, targetRole: Role): boolean {
  if (targetRole === 'owner') return actorRole === 'owner';
  return roleHasPermission(actorRole, 'users.manage');
}
