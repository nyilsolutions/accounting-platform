import { Body, Controller, Delete, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import {
  changePasswordSchema,
  loginSchema,
  mfaVerifySchema,
  registerSchema,
  totpCodeSchema,
  type LoginInput,
  type MeDto,
  type ChangePasswordInput,
  type MfaEnableDto,
  type MfaSetupDto,
  type RegisterInput,
  type SessionDto,
} from '@acct/shared';
import { AllowPendingMfa, CurrentAuth, Meta, Public } from '../common/decorators';
import type { AuthContext, RequestMeta } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { AuthService } from './auth.service';
import { RequireRecentMfa } from './recent-mfa.guard';
import { SessionService } from './session.service';

// Stricter per-IP limit on credential endpoints (in addition to account lockout).
const AUTH_THROTTLE = {
  default: { limit: () => Number(process.env.RATE_LIMIT_AUTH_PER_MINUTE ?? 20), ttl: 60_000 },
};

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('register')
  async register(
    @Body(new ZodPipe(registerSchema)) body: RegisterInput,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeDto> {
    const { token, me } = await this.auth.register(body, meta);
    this.sessions.setCookie(res, token);
    return me;
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodPipe(loginSchema)) body: LoginInput,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeDto> {
    const { token, me } = await this.auth.login(body, meta);
    this.sessions.setCookie(res, token);
    return me;
  }

  @AllowPendingMfa()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(auth, meta);
    this.sessions.clearCookie(res);
  }

  @AllowPendingMfa()
  @Get('me')
  me(@CurrentAuth() auth: AuthContext): MeDto {
    return this.auth.me(auth);
  }

  @AllowPendingMfa()
  @Post('mfa/setup')
  @HttpCode(200)
  setupMfa(@CurrentAuth() auth: AuthContext): Promise<MfaSetupDto> {
    return this.auth.beginMfaSetup(auth);
  }

  @AllowPendingMfa()
  @Throttle(AUTH_THROTTLE)
  @Post('mfa/enable')
  @HttpCode(200)
  async enableMfa(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(totpCodeSchema)) body: { code: string },
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MfaEnableDto> {
    const { token, result } = await this.auth.enableMfa(auth, body.code, meta);
    this.sessions.setCookie(res, token);
    return result;
  }

  @AllowPendingMfa()
  @Throttle(AUTH_THROTTLE)
  @Post('mfa/verify')
  @HttpCode(204)
  async verifyMfa(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(mfaVerifySchema)) body: { code: string },
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const token = await this.auth.verifyMfa(auth, body.code, meta);
    this.sessions.setCookie(res, token);
  }

  /** A fresh code for a sensitive action (step-up, ADR 0029). */
  @Throttle(AUTH_THROTTLE)
  @Post('step-up')
  @HttpCode(204)
  stepUp(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(totpCodeSchema)) body: { code: string },
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.auth.stepUp(auth, body.code, meta);
  }

  @Throttle(AUTH_THROTTLE)
  @RequireRecentMfa()
  @Post('password')
  @HttpCode(204)
  changePassword(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(changePasswordSchema)) body: ChangePasswordInput,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.auth.changePassword(auth, body, meta);
  }

  @RequireRecentMfa()
  @Post('mfa/recovery-codes')
  @HttpCode(200)
  regenerateRecoveryCodes(
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ): Promise<MfaEnableDto> {
    return this.auth.regenerateRecoveryCodes(auth, meta);
  }

  @Get('sessions')
  sessionsList(@CurrentAuth() auth: AuthContext): Promise<SessionDto[]> {
    return this.auth.listSessions(auth);
  }

  @Post('sessions/sign-out-others')
  @HttpCode(200)
  signOutOthers(
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ): Promise<{ signedOut: number }> {
    return this.auth.signOutOthers(auth, meta);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  revokeSession(
    @CurrentAuth() auth: AuthContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.auth.revokeSession(auth, id, meta);
  }
}
