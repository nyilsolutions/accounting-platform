import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Db, Tx } from '@acct/db';
import { APP_CONFIG, type AppConfig } from '../config';
import { DB } from '../db/db.module';
import { JobQueue } from '../jobs/job-queue.service';
import { MAILER, type Mailer } from '../mail/mailer';

/**
 * Emails telling people about changes to their sign-in (ASVS 2.2.3, 2.5.5, 2.8.5; ADR 0029).
 * Sent through the job queue, so a mail outage never blocks a sign-in and a lost send is retried.
 * The job carries the user id and the event only.
 */
export type SecurityEvent =
  | 'password_changed'
  | 'mfa_enabled'
  | 'recovery_code_used'
  | 'recovery_codes_regenerated'
  | 'locked_out'
  | 'totp_replayed'
  | 'new_device'
  | 'sessions_signed_out';

const MESSAGES: Record<SecurityEvent, { subject: string; body: string }> = {
  password_changed: {
    subject: 'Your password was changed',
    body: 'Your password was changed, and your other sessions were signed out.',
  },
  mfa_enabled: {
    subject: 'Two-step verification is on',
    body: 'Two-step verification was turned on for your account.',
  },
  recovery_code_used: {
    subject: 'A recovery code was used to sign in',
    body: 'Someone signed in to your account with one of your recovery codes. Each code works once; you can make new ones in Settings > Security.',
  },
  recovery_codes_regenerated: {
    subject: 'New recovery codes were made',
    body: 'New recovery codes were made for your account. The old ones no longer work.',
  },
  locked_out: {
    subject: 'Sign-in locked after failed attempts',
    body: 'Sign-in to your account was locked for a while after too many failed attempts.',
  },
  totp_replayed: {
    subject: 'A used sign-in code was tried again',
    body: 'A code from your authenticator app was used a second time. That can mean someone saw the code or has your authenticator secret.',
  },
  new_device: {
    subject: 'New sign-in to your account',
    body: 'Your account was signed in to from a browser or device it has not used recently.',
  },
  sessions_signed_out: {
    subject: 'Your other sessions were signed out',
    body: 'All your other sessions were signed out.',
  },
};

@Injectable()
export class SecurityNoticesService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly jobs: JobQueue,
  ) {}

  onModuleInit(): void {
    this.jobs.register('security.notice', async (d) => this.deliver(d.userId, d.event, d.at));
  }

  /** Queues the email; pass `tx` when it must go only if the change commits. */
  notify(userId: string, event: SecurityEvent, opts: { tx?: Tx } = {}): Promise<void> {
    return this.jobs.send(
      'security.notice',
      { userId, event, at: new Date().toISOString() },
      { tx: opts.tx },
    );
  }

  private async deliver(userId: string, event: SecurityEvent, at: string): Promise<void> {
    const user = await this.db
      .selectFrom('users')
      .select(['email', 'full_name'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user) return;
    const m = MESSAGES[event];
    await this.mailer.send({
      to: user.email,
      subject: `${m.subject} (${this.config.APP_NAME})`,
      text: [
        `Hi ${user.full_name},`,
        '',
        m.body,
        `When: ${new Date(at).toUTCString()}`,
        '',
        "If this was you, there's nothing to do. If it wasn't, change your password and review your sessions now:",
        `${this.config.WEB_ORIGIN}/settings/security`,
      ].join('\n'),
    });
  }
}
