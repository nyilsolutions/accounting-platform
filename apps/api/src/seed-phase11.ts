import { NestFactory } from '@nestjs/core';
import { withTenant, type Db } from '@acct/db';
import {
  addDays,
  PERMISSIONS,
  stateRegistrationInputSchema,
  todayIso,
  weekday,
} from '@acct/shared';
import { AppModule } from './app.module';
import type { AuthContext, CompanyContext, RequestMeta } from './common/request';
import type { AppConfig } from './config';
import { EfileService } from './efile/efile.service';
import { PayrollLiabilitiesService } from './payroll/liabilities.service';
import { EftpsService } from './payroll/partners/eftps.service';
import { PayrollSetupService } from './payroll/payroll-setup.service';

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

/**
 * Phase 11b demo (ADR 0025): the company is enrolled in EFTPS through the stand-in, and its
 * oldest unpaid Form 941 deposit is scheduled for the next business day. Direct deposit stays a
 * NACHA file; the demo script switches it to the payments partner.
 */
export async function seedPhase11b(
  db: Db,
  config: AppConfig,
  userId: string,
  companyId: string,
): Promise<void> {
  if (config.EFTPS_BATCH_PROVIDER !== 'stand-in') return;
  const lookup = await withTenant(db, { userId, companyId }, async (tx) => ({
    done: await tx
      .selectFrom('eftps_enrollments')
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

  const app = await NestFactory.createApplicationContext(
    AppModule.forRoot({
      ...config,
      REPORT_SCHEDULER: 'off',
      EFILE_ACK_POLLER: 'off',
      PAYROLL_PARTNER_POLLER: 'off',
    }),
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
    const eftps = app.get(EftpsService);
    await eftps.enroll(
      auth,
      ctx,
      {
        routingNumber: '021000021',
        accountNumber: '000555123456',
        accountType: 'checking',
        authorizedName: lookup.user.full_name,
        authorizedTitle: 'Owner',
        authorize: true,
      },
      meta,
    );
    await eftps.standInEnrollment(auth, ctx, { action: 'enroll' });

    const owed = (await app.get(PayrollLiabilitiesService).list(auth, ctx)).liabilities
      .filter((l) => l.agency === 'federal_941' && l.balance !== '0.00')
      .sort((a, b) => a.periodStart.localeCompare(b.periodStart))[0];
    if (!owed) return;
    let settles = addDays(todayIso(), 1);
    while (weekday(settles) === 0 || weekday(settles) === 6) settles = addDays(settles, 1);
    await eftps.pay(
      auth,
      ctx,
      {
        agency: owed.agency,
        periodStart: owed.periodStart,
        periodEnd: owed.periodEnd,
        paymentDate: settles,
        amount: owed.balance,
        method: 'eftps',
        reference: null,
        bankAccountId: null,
      },
      meta,
    );
  } finally {
    await app.close();
  }
}

/**
 * Phase 11c demo (ADR 0026): the company has registered in Washington, whose payroll taxes
 * aren't built in. With no licensed tax engine set up, Payroll › Setup shows it needs one (and a
 * Washington paycheck would be refused). No employee works there, so the demo's runs stay clean.
 */
export async function seedPhase11c(
  db: Db,
  config: AppConfig,
  userId: string,
  companyId: string,
): Promise<void> {
  const lookup = await withTenant(db, { userId, companyId }, async (tx) => ({
    done: await tx
      .selectFrom('payroll_state_registrations')
      .select('id')
      .where('company_id', '=', companyId)
      .where('state', '=', 'WA')
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

  const app = await NestFactory.createApplicationContext(
    AppModule.forRoot({
      ...config,
      REPORT_SCHEDULER: 'off',
      EFILE_ACK_POLLER: 'off',
      PAYROLL_PARTNER_POLLER: 'off',
    }),
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
    await app.get(PayrollSetupService).saveRegistration(
      auth,
      ctx,
      null,
      stateRegistrationInputSchema.parse({
        state: 'WA',
        unemploymentAccountNumber: '000-123456-00-1',
      }),
      meta,
    );
  } finally {
    await app.close();
  }
}
