import {
  createParamDecorator,
  Inject,
  Injectable,
  NotFoundException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { withTenant, type Db } from '@acct/db';
import {
  formatDate,
  formatMoney,
  W4_2020_STATUS_LABELS,
  W4_PRE2020_STATUS_LABELS,
  type Permission,
  type PortalKind,
  type W4Input,
} from '@acct/shared';
import type { AppRequest, CompanyContext } from '../common/request';
import { DB } from '../db/db.module';

/** The signed-in person's link in the company named by the route (ADR 0023). */
export interface PortalContext {
  companyId: string;
  linkId: string;
  kind: PortalKind;
  employeeId: string | null;
  vendorId: string | null;
}

/**
 * Worker portal routes (`portal/:companyId/…`): the session (password + MFA) is checked by the
 * global guard; this checks the person has a live link in that company. No link: 404, like a
 * company the person isn't a member of.
 */
@Injectable()
export class WorkerPortalGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest & { portal?: PortalContext }>();
    const companyId = req.params.companyId as string | undefined;
    if (!req.auth || !companyId || !/^[0-9a-f-]{36}$/i.test(companyId))
      throw new NotFoundException();
    const link = await withTenant(this.db, { userId: req.auth.userId, companyId }, (tx) =>
      tx
        .selectFrom('portal_links')
        .select(['id', 'kind', 'employee_id', 'vendor_id'])
        .where('company_id', '=', companyId)
        .where('user_id', '=', req.auth!.userId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst(),
    );
    if (!link) throw new NotFoundException();
    req.portal = {
      companyId,
      linkId: link.id,
      kind: link.kind,
      employeeId: link.employee_id,
      vendorId: link.vendor_id,
    };
    return true;
  }
}

export const CurrentPortal = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AppRequest & { portal?: PortalContext }>();
  return req.portal;
});

/**
 * A narrow company context for calling the normal services on the person's own records. The
 * portal has already proven the record is theirs; this grants only what that call needs.
 */
export function portalCompanyContext(
  portal: Pick<PortalContext, 'companyId'>,
  permissions: Permission[],
): CompanyContext {
  return { companyId: portal.companyId, role: 'reports_only', permissions };
}

/** A W-4 line by line, as the employee and the reviewer see it. */
export function w4Lines(
  w:
    | W4Input
    | {
        formVersion: string;
        filingStatus: string;
        multipleJobs?: boolean;
        dependentsAmount?: string;
        otherIncome?: string;
        deductions?: string;
        allowances?: number;
        extraWithholding?: string;
        exempt?: boolean;
        effectiveFrom: string;
      },
): string[] {
  const status =
    w.formVersion === '2020'
      ? (W4_2020_STATUS_LABELS as Record<string, string>)[w.filingStatus]
      : (W4_PRE2020_STATUS_LABELS as Record<string, string>)[w.filingStatus];
  const lines = [
    `Form W-4 (${w.formVersion === '2020' ? '2020 or later' : 'before 2020'}), effective ${formatDate(w.effectiveFrom)}`,
    `Filing status: ${status ?? w.filingStatus}`,
  ];
  if (w.formVersion === '2020') {
    const x = w as {
      multipleJobs?: boolean;
      dependentsAmount?: string;
      otherIncome?: string;
      deductions?: string;
    };
    if (x.multipleJobs) lines.push('Step 2: multiple jobs or spouse works');
    if (x.dependentsAmount && x.dependentsAmount !== '0')
      lines.push(`Step 3 dependents: ${formatMoney(x.dependentsAmount)}`);
    if (x.otherIncome && x.otherIncome !== '0')
      lines.push(`Step 4(a) other income: ${formatMoney(x.otherIncome)}`);
    if (x.deductions && x.deductions !== '0')
      lines.push(`Step 4(b) deductions: ${formatMoney(x.deductions)}`);
  } else {
    lines.push(`Allowances: ${(w as { allowances?: number }).allowances ?? 0}`);
  }
  if (w.extraWithholding && w.extraWithholding !== '0')
    lines.push(`Extra withholding per paycheck: ${formatMoney(w.extraWithholding)}`);
  if (w.exempt) lines.push('Exempt from withholding');
  return lines;
}

/** A direct deposit account, masked. */
export function bankLine(a: {
  routingNumber: string;
  accountLast4: string;
  accountType: string;
  amountType: string;
  amount?: string | null;
}): string {
  const share =
    a.amountType === 'remainder'
      ? 'the rest'
      : a.amountType === 'percent'
        ? `${a.amount}%`
        : formatMoney(a.amount ?? '0');
  return `${a.accountType === 'savings' ? 'Savings' : 'Checking'} ****${a.accountLast4} (routing ${a.routingNumber}): ${share}`;
}
