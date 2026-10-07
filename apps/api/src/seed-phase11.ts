import { NestFactory } from '@nestjs/core';
import { withTenant, type Db } from '@acct/db';
import { PERMISSIONS, todayIso } from '@acct/shared';
import { AppModule } from './app.module';
import type { AuthContext, CompanyContext, RequestMeta } from './common/request';
import type { AppConfig } from './config';
import { EfileService } from './efile/efile.service';

/**
 * Phase 11a demo (ADR 0024): the quarter before last's Form 941 was filed electronically and
 * accepted; last quarter's was rejected by the (stand-in) IRS and waits to be fixed and sent
 * again. Needs the stand-in transmitter.
 */
export async function seedPhase11a(
  db: Db,
  config: AppConfig,
  userId: string,
  companyId: string,
): Promise<void> {
  if (config.EFILE_TRANSMITTER !== 'stand-in') return;
  const lookup = await withTenant(db, { userId, companyId }, async (tx) => ({
    done: await tx
      .selectFrom('efile_submissions')
      .select('id')
      .where('company_id', '=', companyId)
      .executeTakeFirst(),
    payroll: await tx
      .selectFrom('payroll_settings')
      .select('company_id')
      .where('company_id', '=', companyId)
      .executeTakeFirst(),
    user: await tx
      .selectFrom('users')
      .select(['email', 'full_name'])
      .where('id', '=', userId)
      .executeTakeFirst(),
  }));
  if (lookup.done || !lookup.payroll || !lookup.user) return;

  // The last two finished quarters.
  const today = todayIso();
  let year = Number(today.slice(0, 4));
  let quarter = Math.floor((Number(today.slice(5, 7)) - 1) / 3);
  const back = () => {
    if (quarter === 0) {
      quarter = 4;
      year -= 1;
    }
    return { year, quarter: quarter-- };
  };
  const last = back();
  const before = back();

  const app = await NestFactory.createApplicationContext(
    AppModule.forRoot({ ...config, REPORT_SCHEDULER: 'off', EFILE_ACK_POLLER: 'off' }),
    { logger: ['error'] },
  );
  try {
    const auth: AuthContext = {
      sessionId: 'seed',
      userId,
      email: lookup.user.email,
      fullName: lookup.user.full_name,
      mfaEnrolled: true,
      mfaVerified: true,
    };
    const ctx: CompanyContext = { companyId, role: 'owner', permissions: PERMISSIONS };
    const meta: RequestMeta = { ip: null, userAgent: 'seed', requestId: null };
    const efile = app.get(EfileService);
    const signer = { name: lookup.user.full_name, title: 'Owner', phone: '512-555-0100' };
    const send = (p: { year: number; quarter: number }) =>
      efile.transmit(
        auth,
        ctx,
        { form: 'form_941', taxYear: p.year, quarter: p.quarter, signer, attest: true },
        meta,
      );
    const forms = ['form_941', 'form_940'] as const;

    const accepted = await send(before);
    if (accepted.status === 'transmitted')
      await efile.standInAnswer(auth, ctx, forms, accepted.id, { action: 'accept' });
    const rejected = await send(last);
    if (rejected.status === 'transmitted')
      await efile.standInAnswer(auth, ctx, forms, rejected.id, {
        action: 'reject',
        errors: [
          {
            code: 'SI-0001',
            message: 'The business name does not match the name the IRS has for this EIN.',
          },
        ],
      });
  } finally {
    await app.close();
  }
}
