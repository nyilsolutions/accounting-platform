import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  getDummyPasswordHash,
  hashPassword,
  normalizeRecoveryCode,
  otpauthUrl,
  sha256,
  verifyPassword,
  verifyTotp,
  type FieldEncryptor,
} from '@acct/crypto';
import type { Db, User } from '@acct/db';
import type { LoginInput, MeDto, MfaEnableDto, MfaSetupDto, RegisterInput } from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config';
import type { AuthContext, RequestMeta } from '../common/request';
import { DB, FIELD_ENCRYPTOR } from '../db/db.module';
import { SessionService } from './session.service';

const INVALID_CREDENTIALS = 'Invalid email or password';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(FIELD_ENCRYPTOR) private readonly encryptor: FieldEncryptor,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  async register(input: RegisterInput, meta: RequestMeta): Promise<{ token: string; me: MeDto }> {
    const existing = await this.db
      .selectFrom('users')
      .select('id')
      .where('email', '=', input.email)
      .executeTakeFirst();
    if (existing) throw new ConflictException('An account with this email already exists');

    const user = await this.db
      .insertInto('users')
      .values({
        email: input.email,
        full_name: input.fullName,
        password_hash: await hashPassword(input.password),
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
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    this.assertNotLocked(user);
    if (!(await verifyPassword(user.password_hash, input.password))) {
      await this.registerFailure(user, meta, 'password');
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    await this.db
      .updateTable('users')
      .set({ failed_login_count: 0, locked_until: null })
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

    const recoveryCodes = generateRecoveryCodes();
    await this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable('users')
        .set({ mfa_enabled_at: new Date(), mfa_last_used_step: step })
        .where('id', '=', user.id)
        .execute();
      await tx.deleteFrom('mfa_recovery_codes').where('user_id', '=', user.id).execute();
      await tx
        .insertInto('mfa_recovery_codes')
        .values(
          recoveryCodes.map((c) => ({
            user_id: user.id,
            code_hash: sha256(normalizeRecoveryCode(c)),
          })),
        )
        .execute();
    });
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
    const token = await this.sessions.elevate(auth.sessionId);
    return { token, result: { recoveryCodes } };
  }

  /** Completes sign-in with a TOTP code or a one-time recovery code. */
  async verifyMfa(auth: AuthContext, code: string, meta: RequestMeta): Promise<string> {
    if (!auth.mfaEnrolled) throw new ConflictException('MFA is not enabled');
    const user = await this.getUser(auth.userId);
    this.assertNotLocked(user);

    let method: 'totp' | 'recovery_code' | null = null;
    if (/^\d{6}$/.test(code.trim())) {
      const secret = this.encryptor.decrypt(user.mfa_secret_enc!, mfaAad(user.id));
      const lastUsed = user.mfa_last_used_step === null ? null : Number(user.mfa_last_used_step);
      const step = verifyTotp(secret, code.trim(), { lastUsedStep: lastUsed });
      if (step !== null) {
        await this.db
          .updateTable('users')
          .set({ mfa_last_used_step: step })
          .where('id', '=', user.id)
          .execute();
        method = 'totp';
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
      await this.registerFailure(user, meta, 'mfa');
      throw new UnauthorizedException('That code is not valid');
    }
    await this.db
      .updateTable('users')
      .set({ failed_login_count: 0, locked_until: null })
      .where('id', '=', user.id)
      .execute();
    await this.audit.recordStandalone(
      {
        companyId: null,
        actorUserId: user.id,
        action: method === 'totp' ? 'auth.mfa_verified' : 'auth.recovery_code_used',
        entityType: 'user',
        entityId: user.id,
      },
      meta,
    );
    return this.sessions.elevate(auth.sessionId);
  }

  private async getUser(id: string): Promise<User> {
    return this.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  }

  private assertNotLocked(user: User): void {
    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      throw new HttpException(
        'Too many failed attempts. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async registerFailure(
    user: User,
    meta: RequestMeta,
    factor: 'password' | 'mfa',
  ): Promise<void> {
    const failures = user.failed_login_count + 1;
    const lock = failures >= this.config.LOGIN_MAX_FAILED_ATTEMPTS;
    await this.db
      .updateTable('users')
      .set({
        failed_login_count: lock ? 0 : failures,
        locked_until: lock
          ? new Date(Date.now() + this.config.LOGIN_LOCKOUT_MINUTES * 60_000)
          : user.locked_until,
      })
      .where('id', '=', user.id)
      .execute();
    await this.audit.recordStandalone(
      {
        companyId: null,
        actorUserId: user.id,
        action: lock ? 'auth.locked_out' : 'auth.login_failed',
        entityType: 'user',
        entityId: user.id,
        metadata: { factor },
      },
      meta,
    );
  }
}

function mfaAad(userId: string): string {
  return `user:${userId}:mfa`;
}

function toMe(user: User, mfaVerified: boolean): MeDto {
  return {
    user: { id: user.id, email: user.email, fullName: user.full_name },
    mfaEnrolled: user.mfa_enabled_at !== null,
    mfaVerified,
  };
}
