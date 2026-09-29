import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALLOW_PENDING_MFA, IS_PUBLIC } from '../common/decorators';
import type { AppRequest } from '../common/request';
import { SessionService } from './session.service';

/**
 * Global guard. Every route requires a session with a completed MFA challenge unless marked
 * @Public() or @AllowPendingMfa().
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>();
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets);

    const token = req.cookies?.[this.sessions.cookieName] as string | undefined;
    if (token) {
      const auth = await this.sessions.resolve(token);
      if (auth) req.auth = auth;
    }
    if (isPublic) return true;
    if (!req.auth) throw new UnauthorizedException('Sign in required');

    const allowPendingMfa = this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_MFA, targets);
    if (!req.auth.mfaVerified && !allowPendingMfa) {
      throw new UnauthorizedException({
        statusCode: 401,
        message: req.auth.mfaEnrolled ? 'MFA verification required' : 'MFA enrollment required',
        code: req.auth.mfaEnrolled ? 'MFA_REQUIRED' : 'MFA_ENROLLMENT_REQUIRED',
      });
    }
    return true;
  }
}
