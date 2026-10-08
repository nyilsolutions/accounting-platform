/**
 * Development seed: a demo owner and the "Sample Landscaping Co." demo company.
 * Idempotent. Prints the demo MFA secret so it can be added to an authenticator app.
 * Refuses to run in production.
 */
import { randomUUID } from 'node:crypto';
import { generateTotp, generateTotpSecret, hashPassword, LocalAesGcmEncryptor } from '@acct/crypto';
import { createDb, withTenant } from '@acct/db';
import { loadConfig } from './config';

const DEMO_EMAIL = 'demo@example.com';
const DEMO_PASSWORD = 'demo-password-change-me';
const DEMO_COMPANY = 'Sample Landscaping Co.';

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.NODE_ENV === 'production') throw new Error('Refusing to seed a production database');
  const db = createDb(config.DATABASE_URL, 1);
  const enc = new LocalAesGcmEncryptor({ 1: config.FIELD_ENCRYPTION_KEY }, 1);
  try {
    let user = await db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', DEMO_EMAIL)
      .executeTakeFirst();
    let secret: string;
    if (user) {
      secret = enc.decrypt(user.mfa_secret_enc!, `user:${user.id}:mfa`);
    } else {
      secret = generateTotpSecret();
      const id = randomUUID();
      user = await db
        .insertInto('users')
        .values({
          id,
          email: DEMO_EMAIL,
          full_name: 'Demo Owner',
          password_hash: await hashPassword(DEMO_PASSWORD),
          mfa_secret_enc: enc.encrypt(secret, `user:${id}:mfa`),
          mfa_enabled_at: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    }

    const userId = user.id;
    const existing = await withTenant(db, { userId, companyId: null }, (tx) =>
      tx
        .selectFrom('companies')
        .select('id')
        .where('legal_name', '=', DEMO_COMPANY)
        .executeTakeFirst(),
    );
    if (!existing) {
      const companyId = randomUUID();
      await withTenant(db, { userId, companyId }, async (tx) => {
        await tx
          .insertInto('companies')
          .values({
            id: companyId,
            legal_name: DEMO_COMPANY,
            dba_name: 'Sample Landscaping',
            ein_enc: enc.encrypt('12-3456789', `company:${companyId}:ein`),
            ein_last4: '6789',
            address_line1: '100 Main St',
            city: 'Austin',
            state: 'TX',
            postal_code: '78701',
            phone: '(512) 555-0100',
            email: 'office@sample-landscaping.example',
            fiscal_year_start_month: 1,
            tax_form: 'form_1120s',
            accounting_basis: 'accrual',
            created_by: userId,
            updated_by: userId,
          })
          .execute();
        await tx
          .insertInto('memberships')
          .values({ company_id: companyId, user_id: userId, role: 'owner' })
          .execute();
        await tx
          .insertInto('audit_log')
          .values({
            company_id: companyId,
            actor_user_id: userId,
            action: 'company.created',
            entity_type: 'company',
            entity_id: companyId,
            before: null,
            after: JSON.stringify({ legalName: DEMO_COMPANY, source: 'seed' }),
            metadata: null,
          })
          .execute();
      });
    }

    console.log(
      [
        '',
        'Demo data ready.',
        `  Email:      ${DEMO_EMAIL}`,
        `  Password:   ${DEMO_PASSWORD}`,
        `  MFA secret: ${secret}  (add to an authenticator app)`,
        `  Current code: ${generateTotp(secret)}`,
        '',
      ].join('\n'),
    );
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
