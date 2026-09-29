import { NestFactory } from '@nestjs/core';
import { withTenant, type Db } from '@acct/db';
import { companyInputSchema, PERMISSIONS } from '@acct/shared';
import { AppModule } from './app.module';
import type { AuthContext, CompanyContext, RequestMeta } from './common/request';
import type { AppConfig } from './config';
import { CompaniesService } from './companies/companies.service';
import { MigrationsService } from './migration/migrations.service';
import { QboService } from './migration/qbo.service';

export const IMPORTED_COMPANY = 'Sunrise Landscaping (from QuickBooks)';

/**
 * Demo of Phase 6: a second company imported from the development QuickBooks Online company
 * (the mock, see migration/sources/qbo/mock-company.ts), through the real connect → pull →
 * import → complete path. One attachment waits on "Match attachments".
 */
export async function seedMigration(db: Db, config: AppConfig, userId: string): Promise<void> {
  if (config.QBO_ENVIRONMENT !== 'mock') {
    console.log('Skipping the QuickBooks demo: QBO_ENVIRONMENT is not "mock".');
    return;
  }
  const existing = await withTenant(db, { userId, companyId: null }, (tx) =>
    tx
      .selectFrom('companies')
      .select('id')
      .where('legal_name', '=', IMPORTED_COMPANY)
      .executeTakeFirst(),
  );
  if (existing) return;

  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), {
    logger: ['error'],
  });
  try {
    const auth: AuthContext = {
      sessionId: 'seed',
      userId,
      email: 'demo@example.com',
      fullName: 'Demo Owner',
      mfaEnrolled: true,
      mfaVerified: true,
    };
    const meta: RequestMeta = { ip: null, userAgent: 'seed', requestId: null };
    const company = await app
      .get(CompaniesService)
      .create(
        auth,
        companyInputSchema.parse({ legalName: IMPORTED_COMPANY, taxForm: 'form_1120s' }),
        meta,
      );
    const ctx: CompanyContext = { companyId: company.id, role: 'owner', permissions: PERMISSIONS };
    const migrations = app.get(MigrationsService);
    const qbo = app.get(QboService);
    const m = await migrations.create(auth, ctx, { source: 'qbo' }, meta);
    const { url } = await qbo.connectUrl(auth, ctx, m.id);
    const q = new URL(url).searchParams;
    await qbo.callback(
      auth,
      { code: q.get('code')!, state: q.get('state')!, realmId: q.get('realmId')! },
      meta,
    );
    await qbo.pull(auth, ctx, m.id, 'full', meta);
    await qbo.idle(m.id);
    await migrations.run(auth, ctx, m.id, undefined, meta);
    await migrations.idle(m.id);
    const done = await migrations.complete(auth, ctx, m.id, { acceptDifferences: false }, meta);
    console.log(
      `QuickBooks demo: "${IMPORTED_COMPANY}" imported (${done.counts.imported} records) and tied out.`,
    );
  } finally {
    await app.close();
  }
}
