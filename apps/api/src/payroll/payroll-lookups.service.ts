import { Inject, Injectable } from '@nestjs/common';
import { withTenant, type Db } from '@acct/db';
import type { PayrollLookupsDto } from '@acct/shared';
import type { AuthContext, CompanyContext } from '../common/request';
import { buildTree, flattenTree } from '../common/tree';
import { DB } from '../db/db.module';
import { EXPENSE_TYPES, LIABILITY_TYPES } from './payroll-common';

/** The accounts, vendors, classes and locations payroll screens choose from. */
@Injectable()
export class PayrollLookupsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  get(auth: AuthContext, ctx: CompanyContext): Promise<PayrollLookupsDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const [accounts, vendors, classes, locations, members] = await Promise.all([
        tx
          .selectFrom('accounts')
          .select(['id', 'parent_id', 'name', 'number', 'account_type'])
          .where('company_id', '=', ctx.companyId)
          .where('is_active', '=', true)
          .where('account_type', 'in', [...EXPENSE_TYPES, ...LIABILITY_TYPES, 'bank'])
          .execute(),
        tx
          .selectFrom('vendors')
          .select(['id', 'display_name'])
          .where('company_id', '=', ctx.companyId)
          .where('is_active', '=', true)
          .orderBy('display_name')
          .execute(),
        tx
          .selectFrom('classes')
          .select(['id', 'parent_id', 'name'])
          .where('company_id', '=', ctx.companyId)
          .where('is_active', '=', true)
          .execute(),
        tx
          .selectFrom('locations')
          .select(['id', 'parent_id', 'name'])
          .where('company_id', '=', ctx.companyId)
          .where('is_active', '=', true)
          .execute(),
        tx
          .selectFrom('memberships as m')
          .innerJoin('users as u', 'u.id', 'm.user_id')
          .select(['u.id', 'u.full_name'])
          .where('m.company_id', '=', ctx.companyId)
          .orderBy('u.full_name')
          .execute(),
      ]);
      const tree = <T extends { id: string; parent_id: string | null; name: string }>(rows: T[]) =>
        flattenTree(buildTree(rows, (r) => r.name));
      return {
        accounts: flattenTree(
          buildTree(
            accounts,
            (a) => a.name,
            (a) => a.number ?? a.name,
          ),
        ).map((n) => ({
          id: n.item.id,
          fullName: n.fullName,
          accountType: n.item.account_type,
        })),
        vendors: vendors.map((v) => ({ id: v.id, displayName: v.display_name })),
        classes: tree(classes).map((n) => ({ id: n.item.id, fullName: n.fullName })),
        locations: tree(locations).map((n) => ({ id: n.item.id, fullName: n.fullName })),
        members: members.map((u) => ({ userId: u.id, fullName: u.full_name })),
      };
    });
  }
}
