import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  getDummyPasswordHash,
  hashPassword,
  isReplayedTotp,
  normalizeRecoveryCode,
  otpauthUrl,
  sha256,
  verifyPassword,
  verifyTotp,
  type FieldEncryptor,
} from '@acct/crypto';
import { sql, type Db, type User } from '@acct/db';
import {
  PASSWORD_BREACHED,
  type ChangePasswordInput,
  type LoginInput,
  type MeDto,
  type MfaEnableDto,
  type MfaSetupDto,
  type RegisterInput,
  type SessionDto,
} from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config';
import type { AuthContext, RequestMeta } from '../common/request';
import { DB, FIELD_ENCRYPTOR } from '../db/db.module';
import { securityEvent } from '../observability/security-log';
import { mfaAad } from '../security/aad';
import { BREACH_CHECKER, type BreachChecker } from './breach-check';
import { SecurityNoticesService, type SecurityEvent } from './security-notices.service';
import { SessionService } from './session.service';

const INVALID_CREDENTIALS = 'Invalid email or password';

@Injectable()
export class AuthService {
  private readonly pepper: Buffer | undefined;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(FIELD_ENCRYPTOR) private readonly encryptor: FieldEncryptor,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(BREACH_CHECKER) private readonly breaches: BreachChecker,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly notices: SecurityNoticesService,
  ) {
    this.pepper = config.PASSWORD_PEPPER
      ? Buffer.from(config.PASSWORD_PEPPER, 'base64')
      : undefined;
  }

  async register(input: RegisterInput, meta: RequestMeta): Promise<{ token: string; me: MeDto }> {
    const existing = await this.db
      .selectFrom('users')
      .select('id')
      .where('email', '=', input.email)
      .executeTakeFirst();
    if (existing) throw new ConflictException('An account with this email already exists');
    await this.assertNotBreached(input.password, 'password');

    const user = await this.db
      .insertInto('users')
      .values({
        email: input.email,
        full_name: input.fullName,
        password_hash: await hashPassword(input.password, this.pepper),
        password_peppered: !!this.pepper,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.recordStandalone(
      {
        companyId: null,
        actorUserId: user.id,
        action: 'auth.registered',
        entityType: 'user',
        entityId: user.id,
      },
      meta,
    );
    const token = await this.sessions.create(user.id, meta);
    return { token, me: toMe(user, false) };
  }

  async login(input: LoginInput, meta: RequestMeta): Promise<{ token: string; me: MeDto }> {
    const user = await this.db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', input.email)
      .executeTakeFirst();
    if (!user) {
      await verifyPassword(await getDummyPasswordHash(), input.password);
      // No audit row (there is no account to tie it to) and never the address itself.
      securityEvent('auth.login_unknown_account', { ip: meta.ip });
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    this.assertNotLocked(user);
    if (!(await this.checkPassword(user, input.password))) {
      await this.registerFailure(user.id, meta, 'password');
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    // Only the password counter: a correct password says nothing about MFA guesses.
    await this.db
      .updateTable('users')
      .set({ failed_login_count: 0 })
      .where('id', '=', user.id)
      .execute();
    await this.audit.recordStandalone(
      {
        companyId: null,
        actorUserId: user.id,
        action: 'auth.login',
        entityType: 'user',
        entityId: user.id,
      },
      meta,
    );
    const token = await this.sessions.create(user.id, meta);
    return { token, me: toMe(user, false) };
  }

  async logout(auth: AuthContext, meta: RequestMeta): Promise<void> {
    await this.sessions.revoke(auth.sessionId);
    await this.audit.recordStandalone(
      {
        companyId: null,
        actorUserId: auth.userId,
        action: 'auth.logout',
        entityType: 'user',
        entityId: auth.userId,
      },
      meta,
    );
  }

  me(auth: AuthContext): MeDto {
    return {
      user: { id: auth.userId, email: auth.email, fullName: auth.fullName },
      mfaEnrolled: auth.mfaEnrolled,
      mfaVerified: auth.mfaVerified,
    };
  }

  /** Starts (or restarts) enrollment by storing a new pending secret. */
  async beginMfaSetup(auth: AuthContext): Promise<MfaSetupDto> {
    if (auth.mfaEnrolled) throw new ConflictException('MFA is already enabled');
    const secret = generateTotpSecret();
    await this.db
      .updateTable('users')
      .set({ mfa_secret_enc: this.encryptor.encrypt(secret, mfaAad(auth.userId)) })
      .where('id', '=', auth.userId)
      .execute();
    return {
      secret,
      otpauthUrl: otpauthUrl({ secret, accountName: auth.email, issuer: this.config.APP_NAME }),
    };
  }

  async enableMfa(
    auth: AuthContext,
    code: string,
    meta: RequestMeta,
  ): Promise<{ token: string; result: MfaEnableDto }> {
    if (auth.mfaEnrolled) throw new ConflictException('MFA is already enabled');
    const user = await this.getUser(auth.userId);
    if (!user.mfa_secret_enc) throw new ConflictException('Start MFA setup first');
    const secret = this.encryptor.decrypt(user.mfa_secret_enc, mfaAad(user.id));
    const step = verifyTotp(secret, code);
    if (step === null)
      throw new UnauthorizedException(
        'That code is not valid. Check your device clock and try again.',
      );

    const recoveryCodes = await this.replaceRecoveryCodes(user.id, step);
    await this.audit.recordStandalone(
      {
        companyId: null,
        actorUserId: user.id,
        action: 'auth.mfa_enabled',
        entityType: 'user',
        entityId: user.id,
      },
      meta,
    );
    await this.notices.notify(user.id, 'mfa_enabled');
    const token = await this.sessions.elevate(auth.sessionId);
    return { token, result: { recoveryCodes } };
  }

  /** Completes sign-in with a TOTP code or a one-time recovery code. */
  async verifyMfa(auth: AuthContext, code: string, meta: RequestMeta): Promise<string> {
    if (!auth.mfaEnrolled) throw new ConflictException('MFA is not enabled');
    const method = await this.checkSecondFactor(auth.userId, code, meta);
    await this.audit.recordStandalone(
      {
        companyId: null,
        actorUserId: auth.userId,
        action: method === 'totp' ? 'auth.mfa_verified' : 'auth.recovery_code_used',
        entityType: 'user',
        entityId: auth.userId,
      },
      meta,
    );
    if (method === 'recovery_code') await this.notices.notify(auth.userId, 'recovery_code_used');
    else if (await this.isNewDevice(auth, meta))
      await this.notices.notify(auth.userId, 'new_device');
    return this.sessions.elevate(auth.sessionId);
  }

  /**
   * A fresh code for a sensitive action (ADR 0029): the session is marked as having passed MFA
   * now, without changing its token. Only an authenticator code counts, not a recovery code.
   */
  async stepUp(auth: AuthContext, code: string, meta: RequestMeta): Promise<void> {
    if (!/^\d{6}$/.test(code.trim())) {
      throw new UnauthorizedException('Enter the 6-digit code from your authenticator app');
    }
    await this.checkSecondFactor(auth.userId, code, meta);
    await this.sessions.markMfaVerified(auth.sessionId);
    await this.audit.recordStandalone(
      {
        companyId: null,
        actorUserId: auth.userId,
        action: 'auth.step_up',
        entityType: 'user',
        entityId: auth.userId,
      },
      meta,
    );
  }

  /**
   * Changes the password (ASVS 2.1.5, 2.1.6). The route needs a recent MFA code; this checks the
   * current password, refuses breached ones, and signs out every other session (ASVS 3.3.3).
   */
  async changePassword(
    auth: AuthContext,
    input: ChangePasswordInput,
    meta: RequestMeta,
  ): Promise<void> {
    const user = await this.getUser(auth.userId);
    this.assertNotLocked(user);
    if (!(await this.checkPassword(user, input.currentPassword))) {
      await this.registerFailure(user.id, meta, 'password');
      throw new BadRequestException({
        statusCode: 400,
        message: 'Validation failed',
        errors: [{ path: 'currentPassword', message: 'That is not your current password' }],
      });
    }
    await this.assertNotBreached(input.newPassword, 'newPassword');
    await this.db
      .updateTable('users')
      .set({
        password_hash: await hashPassword(input.newPassword, this.pepper),
        password_peppered: !!this.pepper,
        password_changed_at: new Date(),
        failed_login_count: 0,
      })
      .where('id', '=', user.id)
      .execute();
    const signedOut = await this.sessions.revokeOthers(user.id, auth.sessionId);
    await this.audit.recordStandalone(
      {
        companyId: null,
        actorUserId: user.id,
        action: 'auth.password_changed',
        entityType: 'user',
        entityId: user.id,
        metadata: { otherSessionsSignedOut: signedOut },
      },
      meta,
    );
    await this.notices.notify(user.id, 'password_changed');
  }

  /** New recovery codes (the old ones stop working). The route needs a recent MFA code. */
  async regenerateRecoveryCodes(auth: AuthContext, meta: RequestMeta): Promise<MfaEnableDto> {
    if (!auth.mfaEnrolled) throw new ConflictException('MFA is not enabled');
    const recoveryCodes = await this.replaceRecoveryCodes(auth.userId);
    await this.audit.recordStandalone(
      {
        companyId: null,
        actorUserId: auth.userId,
        action: 'auth.recovery_codes_regenerated',
        entityType: 'user',
        entityId: auth.userId,
      },
      meta,
    );
    await this.notices.notify(auth.userId, 'recovery_codes_regenerated');
    return { recoveryCodes };
  }

  /** The user's live sessions (ASVS 3.3.4). */
  async listSessions(auth: AuthContext): Promise<SessionDto[]> {
    return (await this.sessions.list(auth.userId)).map((s) => ({
      id: s.id,
      current: s.id === auth.sessionId,
      ip: s.ip,
      userAgent: s.user_agent,
      createdAt: s.created_at.toISOString(),
      lastSeenAt: s.last_seen_at.toISOString(),
    }));
  }

  async revokeSession(auth: AuthContext, sessionId: string, meta: RequestMeta): Promise<void> {
    if (!(await this.sessions.revokeOwn(auth.userId, sessionId))) {
      throw new NotFoundException('Session not found');
    }
    await this.audit.recordStandalone(
      {
        companyId: null,
        actorUserId: auth.userId,
        action: 'auth.session_revoked',
        entityType: 'session',
        entityId: sessionId,
      },
      meta,
    );
  }

  async signOutOthers(auth: AuthContext, meta: RequestMeta): Promise<{ signedOut: number }> {
    const signedOut = await this.sessions.revokeOthers(auth.userId, auth.sessionId);
    await this.audit.recordStandalone(
      {
        companyId: null,
        actorUserId: auth.userId,
        action: 'auth.sessions_signed_out',
        entityType: 'user',
        entityId: auth.userId,
        metadata: { signedOut },
      },
      meta,
    );
    if (signedOut > 0) await this.notices.notify(auth.userId, 'sessions_signed_out');
    return { signedOut };
  }

  // ---- Internals ---------------------------------------------------------------------------

  private async getUser(id: string): Promise<User> {
    return this.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  }

  /**
   * Verifies a password, with the pepper when the hash was made with it. A correct password on
   * an older hash is re-hashed with the pepper (ASVS 2.4.5).
   */
  private async checkPassword(user: User, password: string): Promise<boolean> {
    if (user.password_peppered && !this.pepper) {
      throw new Error('PASSWORD_PEPPER is needed to check this password');
    }
    const ok = await verifyPassword(
      user.password_hash,
      password,
      user.password_peppered ? this.pepper : undefined,
    );
    if (ok && this.pepper && !user.password_peppered) {
      await this.db
        .updateTable('users')
        .set({ password_hash: await hashPassword(password, this.pepper), password_peppered: true })
        .where('id', '=', user.id)
        .where('password_hash', '=', user.password_hash)
        .execute();
    }
    return ok;
  }

  private async assertNotBreached(password: string, path: string): Promise<void> {
    if (await this.breaches.isBreached(password)) {
      throw new BadRequestException({
        statusCode: 400,
        code: PASSWORD_BREACHED,
        message: 'Validation failed',
        errors: [
          {
            path,
            message:
              'This password has appeared in a data breach elsewhere. Choose a different one.',
          },
        ],
      });
    }
  }

  /**
   * Checks a TOTP or recovery code. The last-used step is advanced only if no other request
   * advanced it first, so one code can't be used twice even concurrently (ASVS 2.8.4); a code
   * that was valid but already used is recorded as a replay and the user is told (2.8.5).
   * Failures count toward their own lockout; success clears it.
   */
  private async checkSecondFactor(
    userId: string,
    code: string,
    meta: RequestMeta,
  ): Promise<'totp' | 'recovery_code'> {
    const user = await this.getUser(userId);
    this.assertNotLocked(user);
    let method: 'totp' | 'recovery_code' | null = null;
    let replayed = false;
    if (/^\d{6}$/.test(code.trim())) {
      const secret = this.encryptor.decrypt(user.mfa_secret_enc!, mfaAad(user.id));
      const lastUsed = user.mfa_last_used_step === null ? null : Number(user.mfa_last_used_step);
      const step = verifyTotp(secret, code.trim(), { lastUsedStep: lastUsed });
      if (step !== null) {
        const claimed = await this.db
          .updateTable('users')
          .set({ mfa_last_used_step: step })
          .where('id', '=', user.id)
          .where(sql<boolean>`coalesce(mfa_last_used_step, -1) < ${step}`)
          .executeTakeFirst();
        if (claimed.numUpdatedRows > 0n) method = 'totp';
        else replayed = true;
      } else {
        replayed = isReplayedTotp(secret, code.trim(), lastUsed);
      }
    } else {
      const used = await this.db
        .updateTable('mfa_recovery_codes')
        .set({ used_at: new Date() })
        .where('user_id', '=', user.id)
        .where('code_hash', '=', sha256(normalizeRecoveryCode(code)))
        .where('used_at', 'is', null)
        .executeTakeFirst();
      if (used.numUpdatedRows > 0n) method = 'recovery_code';
    }

    if (!method) {
      if (replayed) {
        await this.audit.recordStandalone(
          {
            companyId: null,
            actorUserId: user.id,
            action: 'auth.totp_replayed',
            entityType: 'user',
            entityId: user.id,
          },
          meta,
        );
        await this.notices.notify(user.id, 'totp_replayed');
      }
      await this.registerFailure(user.id, meta, 'mfa');
      throw new UnauthorizedException('That code is not valid');
    }
    await this.db
      .updateTable('users')
      .set({ mfa_failed_count: 0 })
      .where('id', '=', user.id)
      .execute();
    return method;
  }

  private async replaceRecoveryCodes(userId: string, enabledAtStep?: number): Promise<string[]> {
    const recoveryCodes = generateRecoveryCodes();
    await this.db.transaction().execute(async (tx) => {
      if (enabledAtStep !== undefined) {
        await tx
          .updateTable('users')
          .set({ mfa_enabled_at: new Date(), mfa_last_used_step: enabledAtStep })
          .where('id', '=', userId)
          .execute();
      }
      await tx.deleteFrom('mfa_recovery_codes').where('user_id', '=', userId).execute();
      await tx
        .insertInto('mfa_recovery_codes')
        .values(
          recoveryCodes.map((c) => ({
            user_id: userId,
            code_hash: sha256(normalizeRecoveryCode(c)),
          })),
        )
        .execute();
    });
    return recoveryCodes;
  }

  /** A browser this user hasn't signed in from in 90 days (and not their first sign-in). */
  private async isNewDevice(auth: AuthContext, meta: RequestMeta): Promise<boolean> {
    const other = await this.db
      .selectFrom('sessions')
      .select('id')
      .where('user_id', '=', auth.userId)
      .where('id', '<>', auth.sessionId)
      .limit(1)
      .executeTakeFirst();
    if (!other) return false;
    return !(await this.sessions.seenBefore(auth.userId, meta.userAgent, auth.sessionId));
  }

  private assertNotLocked(user: User): void {
    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      throw new HttpException(
        'Too many failed attempts. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Counts a failed password or code in one statement, so parallel guesses each count (ASVS
   * 2.2.1). Passwords and codes have separate counters; either reaching the limit locks
   * sign-in for a while, and the user is told.
   */
  private async registerFailure(
    userId: string,
    meta: RequestMeta,
    factor: 'password' | 'mfa',
  ): Promise<void> {
    const counter = sql.ref(factor === 'password' ? 'failed_login_count' : 'mfa_failed_count');
    const max = this.config.LOGIN_MAX_FAILED_ATTEMPTS;
    const minutes = this.config.LOGIN_LOCKOUT_MINUTES;
    const row = await sql<{ locked: boolean }>`
      update users set
        ${counter} = case when ${counter} + 1 >= ${max} then 0 else ${counter} + 1 end,
        locked_until = case when ${counter} + 1 >= ${max}
                            then now() + make_interval(mins => ${minutes}) else locked_until end
      where id = ${userId}
      returning (locked_until is not null and locked_until > now()) as locked`.execute(this.db);
    const locked = row.rows[0]?.locked ?? false;
    await this.audit.recordStandalone(
      {
        companyId: null,
        actorUserId: userId,
        action: locked ? 'auth.locked_out' : 'auth.login_failed',
        entityType: 'user',
        entityId: userId,
        metadata: { factor },
      },
      meta,
    );
    if (locked) await this.notices.notify(userId, 'locked_out' satisfies SecurityEvent);
  }
}

function toMe(user: User, mfaVerified: boolean): MeDto {
  return {
    user: { id: user.id, email: user.email, fullName: user.full_name },
    mfaEnrolled: user.mfa_enabled_at !== null,
    mfaVerified,
  };
}
