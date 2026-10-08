import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Tx } from '@acct/db';
import { validationError } from '../sales/sales-common';

export const bad = (path: string, message: string) =>
  new BadRequestException(validationError([{ path, message }]));

export const EXPENSE_TYPES = ['expense', 'other_expense', 'cost_of_goods_sold'];
export const LIABILITY_TYPES = ['other_current_liability', 'long_term_liability'];

/** Checks that each referenced account exists in the company and has one of the allowed types. */
export async function assertAccountTypes(
  tx: Tx,
  companyId: string,
  checks: Array<{ id: string | null | undefined; types: string[]; path: string; label: string }>,
): Promise<void> {
  const ids = checks.map((c) => c.id).filter((id): id is string => !!id);
  if (ids.length === 0) return;
  const rows = await tx
    .selectFrom('accounts')
    .select(['id', 'account_type'])
    .where('company_id', '=', companyId)
    .where('id', 'in', ids)
    .execute();
  const types = new Map(rows.map((r) => [r.id, r.account_type]));
  for (const c of checks) {
    if (!c.id) continue;
    const type = types.get(c.id);
    if (!type) throw bad(c.path, 'Choose an account');
    if (!c.types.includes(type)) throw bad(c.path, `Choose ${c.label}`);
  }
}

/** Payroll must be set up (payroll_settings exists) before schedules, items or employees. */
export async function requirePayroll(tx: Tx, companyId: string): Promise<void> {
  const row = await tx
    .selectFrom('payroll_settings')
    .select('company_id')
    .where('company_id', '=', companyId)
    .executeTakeFirst();
  if (!row) throw new ConflictException('Set up payroll first (Payroll › Setup).');
}

/** Numeric columns come back as '1.5000'; show them without trailing zeros ("1.5"). */
export function trimNumber(v: string | null): string | null {
  if (v === null) return null;
  return v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v;
}
