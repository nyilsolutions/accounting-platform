import {
  ForbiddenException,
  Inject,
  Injectable,
  UseGuards,
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { STEP_UP_REQUIRED } from '@acct/shared';
import { APP_CONFIG, type AppConfig } from '../config';
import type { AppRequest } from '../common/request';

/**
 * Sensitive actions need an MFA code from the last few minutes (step-up, ASVS 3.7.1 and 4.3.3,
 * ADR 0029): revealing SSNs and EINs, exporting full SSNs, changing direct deposit, approving
 * worker changes, changing members and roles, connecting payments, changing the password.
 * A stolen session or an unlocked browser isn't enough on its own. The web app answers the 403
 * by asking for a code (`POST /auth/step-up`) and retrying.
 */
@Injectable()
export class RecentMfaGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const at = ctx.switchToHttp().getRequest<AppRequest>().auth?.mfaVerifiedAt;
    if (at && Date.now() - at.getTime() <= this.config.STEP_UP_MINUTES * 60_000) return true;
    throw new ForbiddenException({
      statusCode: 403,
      code: STEP_UP_REQUIRED,
      message: 'Enter a code from your authenticator app to continue',
    });
  }
}

/** The route needs a recent MFA code. List it above a method-level `CompanyAccessGuard`. */
export const RequireRecentMfa = () => applyDecorators(UseGuards(RecentMfaGuard));
