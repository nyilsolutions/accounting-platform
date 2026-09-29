import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Permission } from '@acct/shared';
import { requestMeta, type AppRequest } from './request';

export const IS_PUBLIC = 'isPublic';
/** Route needs no session. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ALLOW_PENDING_MFA = 'allowPendingMfa';
/** Route needs a session but not a completed MFA challenge (MFA enrollment/verification). */
export const AllowPendingMfa = () => SetMetadata(ALLOW_PENDING_MFA, true);

export const REQUIRED_PERMISSION = 'requiredPermission';
export const RequirePermission = (permission: Permission) =>
  SetMetadata(REQUIRED_PERMISSION, permission);

export const CurrentAuth = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  return req.auth;
});

export const CurrentCompany = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  return req.company;
});

export const Meta = createParamDecorator((_: unknown, ctx: ExecutionContext) =>
  requestMeta(ctx.switchToHttp().getRequest<AppRequest>()),
);
