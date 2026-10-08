import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { withTenant, type Db } from '@acct/db';
import { AuditService } from '../audit/audit.service';
import { DB } from '../db/db.module';

const MAX_FAILURES = 5;
const WINDOW_MINUTES = 15;
const FAILED = 'ledger.closing_password_failed';

/**
 * Limits guesses at a company's closing date password (ASVS 2.2.1, 11.1.4): after 5 wrong ones
 * in 15 minutes a person is refused until the window passes. Each failure is an audit row,
 * written in its own transaction because the request's is rolled back; the count comes from
 * those rows.
 */
@Injectable()
export class ClosingPasswordAttempts {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async assertNotLocked(companyId: string, userId: string): Promise<void> {
    const recent = await withTenant(this.db, { userId, companyId }, (tx) =>
      tx
        .selectFrom('audit_log')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('company_id', '=', companyId)
        .where('actor_user_id', '=', userId)
        .where('action', '=', FAILED)
        .where('created_at', '>', new Date(Date.now() - WINDOW_MINUTES * 60_000))
        .executeTakeFirstOrThrow(),
    );
    if (Number(recent.n) >= MAX_FAILURES)
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Too many wrong closing date passwords. Try again in ${WINDOW_MINUTES} minutes.`,
          code: 'CLOSING_PASSWORD_LOCKED',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
  }

  async recordFailure(companyId: string, userId: string): Promise<void> {
    await withTenant(this.db, { userId, companyId }, (tx) =>
      this.audit.record(
        tx,
        {
          companyId,
          actorUserId: userId,
          action: FAILED,
          entityType: 'company',
          entityId: companyId,
        },
        { ip: null, userAgent: null, requestId: null },
      ),
    );
  }
}
