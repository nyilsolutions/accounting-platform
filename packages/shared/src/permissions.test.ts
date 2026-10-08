import { describe, expect, it } from 'vitest';
import {
  canAssignRole,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLES,
  roleHasPermission,
} from './permissions';

describe('roles and permissions', () => {
  it('owner and admin have every permission', () => {
    for (const p of PERMISSIONS) {
      expect(roleHasPermission('owner', p)).toBe(true);
      expect(roleHasPermission('admin', p)).toBe(true);
    }
  });

  it('accountant cannot manage users', () => {
    expect(roleHasPermission('accountant', 'users.manage')).toBe(false);
    expect(roleHasPermission('accountant', 'ledger.manage')).toBe(true);
  });

  it('limited roles cannot see payroll or audit log', () => {
    for (const r of ['standard', 'sales', 'purchases', 'time_tracking', 'reports_only'] as const) {
      expect(roleHasPermission(r, 'payroll.view')).toBe(false);
      expect(roleHasPermission(r, 'audit.view')).toBe(false);
      expect(roleHasPermission(r, 'company.sensitive.reveal')).toBe(false);
    }
  });

  it('every role can at least view the company', () => {
    for (const r of ROLES) expect(ROLE_PERMISSIONS[r]).toContain('company.view');
  });

  it('only owners can assign the owner role', () => {
    expect(canAssignRole('owner', 'owner')).toBe(true);
    expect(canAssignRole('admin', 'owner')).toBe(false);
    expect(canAssignRole('admin', 'accountant')).toBe(true);
    expect(canAssignRole('accountant', 'standard')).toBe(false);
  });
});
