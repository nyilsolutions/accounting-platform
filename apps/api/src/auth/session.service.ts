import { Inject, Injectable } from '@nestjs/common';
import { generateToken, sha256 } from '@acct/crypto';
import type { Db } from '@acct/db';
import type { Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config';
import type { AuthContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';

@Injectable()
export class SessionService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get cookieName(): string {
    // __Host- prefix: only sent over HTTPS, host-only, path=/ — cannot be set by subdomains.
    return this.config.COOKIE_SECURE ? '__Host-acct_session' : 'acct_session';
  }

  async create(userId: string, meta: RequestMeta, mfaVerified = false): Promise<string> {
    const token = generateToken();
    await this.db
      .insertInto('sessions')
      .values({
        user_id: userId,
        token_hash: sha256(token),
        mfa_verified_at: mfaVerified ? new Date() : null,
        ip: meta.ip,
        user_agent: meta.userAgent,
        expires_at: new Date(Date.now() + this.config.SESSION_ABSOLUTE_HOURS * 3600_000),
      })
      .execute();
    return token;
  }

  /** Resolves a cookie token to an active session, enforcing absolute and idle timeouts. */
  async resolve(token: string): Promise<AuthContext | null> {
    const row = await this.db
      .selectFrom('sessions as s')
      .innerJoin('users as u', 'u.id', 's.user_id')
      .select([
        's.id',
        's.user_id',
        's.mfa_verified_at',
        's.last_seen_at',
        's.expires_at',
        's.revoked_at',
        'u.email',
        'u.full_name',
        'u.mfa_enabled_at',
      ])
      .where('s.token_hash', '=', sha256(token))
      .executeTakeFirst();
    if (!row || row.revoked_at) return null;
    const now = Date.now();
    const idleLimit = this.config.SESSION_IDLE_MINUTES * 60_000;
    if (row.expires_at.getTime() <= now || now - row.last_seen_at.getTime() > idleLimit) {
      await this.revoke(row.id);
      return null;
    }
    if (now - row.last_seen_at.getTime() > 60_000) {
      await this.db
        .updateTable('sessions')
        .set({ last_seen_at: new Date() })
        .where('id', '=', row.id)
        .execute();
    }
    return {
      sessionId: row.id,
      userId: row.user_id,
      email: row.email,
      fullName: row.full_name,
      mfaEnrolled: row.mfa_enabled_at !== null,
      mfaVerified: row.mfa_enabled_at !== null && row.mfa_verified_at !== null,
    };
  }

  /** Marks MFA complete and rotates the token (privilege change => new session identifier). */
  async elevate(sessionId: string): Promise<string> {
    const token = generateToken();
    await this.db
      .updateTable('sessions')
      .set({ token_hash: sha256(token), mfa_verified_at: new Date(), last_seen_at: new Date() })
      .where('id', '=', sessionId)
      .execute();
    return token;
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db
      .updateTable('sessions')
      .set({ revoked_at: new Date() })
      .where('id', '=', sessionId)
      .execute();
  }

  setCookie(res: Response, token: string): void {
    res.cookie(this.cookieName, token, {
      httpOnly: true,
      secure: this.config.COOKIE_SECURE,
      sameSite: 'lax',
      path: '/',
      maxAge: this.config.SESSION_ABSOLUTE_HOURS * 3600_000,
    });
  }

  clearCookie(res: Response): void {
    res.clearCookie(this.cookieName, {
      path: '/',
      secure: this.config.COOKIE_SECURE,
      sameSite: 'lax',
    });
  }
}
