import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { withTenant, type Db } from '@acct/db';
import { ROLE_PERMISSIONS, type Permission, type Role } from '@acct/shared';
import { REQUIRED_PERMISSION } from '../common/decorators';
import type { AppRequest } from '../common/request';
import { isUuid } from '../common/uuid.pipe';
import { DB } from '../db/db.module';

/**
 * Resolves `:companyId`, checks the signed-in user is a member, and enforces @RequirePermission.
 * Non-members get 404 (not 403) so company ids cannot be probed.
 */
@Injectable()
export class CompanyAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DB) private readonly db: Db,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>();
    const companyId = String(req.params.companyId ?? '');
    if (!req.auth || !isUuid(companyId)) throw new NotFoundException('Company not found');

    const membership = await withTenant(this.db, { userId: req.auth.userId, companyId }, (tx) =>
      tx
        .selectFrom('memberships')
        .select('role')
        .where('company_id', '=', companyId)
        .where('user_id', '=', req.auth!.userId)
        .executeTakeFirst(),
    );
    if (!membership) throw new NotFoundException('Company not found');

    const role = membership.role as Role;
    req.company = { companyId: companyId.toLowerCase(), role, permissions: ROLE_PERMISSIONS[role] };

    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(
      REQUIRED_PERMISSION,
      [context.getHandler(), context.getClass()],
    );
    if (required && !required.some((p) => req.company!.permissions.includes(p))) {
      throw new ForbiddenException('You do not have permission to do this');
    }
    return true;
  }
}
