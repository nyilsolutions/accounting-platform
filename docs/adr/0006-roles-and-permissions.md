# ADR 0006: Roles and permissions

- Status: Accepted
- Date: 2026-09-29

## Decision

- Authorization checks **permissions** (e.g. `users.manage`, `payroll.view`). **Roles** are fixed
  bundles defined in `packages/shared/src/permissions.ts`, mirroring QuickBooks user types:
  - Owner
  - Admin
  - Accountant
  - Standard (all transactions)
  - Sales only
  - Purchases only
  - Payroll admin
  - Time tracking only
  - Reports only
- Permissions for later modules are declared now so role definitions stay stable.
- Only an owner can grant, change or remove the owner role, and a company must always have at
  least one owner. The owner rows are locked (`FOR UPDATE`) during changes to prevent races.
- The API enforces permissions (`@RequirePermission`). The web uses them only to hide UI.

## Future

Custom roles with per-module permissions (stored per company), and field-level restrictions
(e.g. hide payroll amounts from non-payroll users in shared reports).
