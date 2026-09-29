/**
 * Development seed: a demo owner and the "Sample Landscaping Co." demo company.
 * Idempotent. Prints the demo MFA secret so it can be added to an authenticator app.
 * Refuses to run in production.
 */
import { randomUUID } from 'node:crypto';
import { generateTotp, generateTotpSecret, hashPassword, LocalAesGcmEncryptor } from '@acct/crypto';
import { createDb, withTenant, type Tx } from '@acct/db';
import { parseMoney } from '@acct/shared';
import { loadConfig } from './config';
import { LedgerSetupService } from './ledger/ledger-setup.service';
import { PostingService } from './ledger/posting.service';

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
    let companyId = existing?.id;
    if (!companyId) {
      companyId = randomUUID();
      await withTenant(db, { userId, companyId }, async (tx) => {
        await tx
          .insertInto('companies')
          .values({
            id: companyId!,
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
          .values({ company_id: companyId!, user_id: userId, role: 'owner' })
          .execute();
        await tx
          .insertInto('audit_log')
          .values({
            company_id: companyId,
            actor_user_id: userId,
            action: 'company.created',
            entity_type: 'company',
            entity_id: companyId!,
            before: null,
            after: JSON.stringify({ legalName: DEMO_COMPANY, source: 'seed' }),
            metadata: null,
          })
          .execute();
      });
    }

    await withTenant(db, { userId, companyId }, async (tx) => {
      const hasAccounts = await tx
        .selectFrom('accounts')
        .select('id')
        .where('company_id', '=', companyId!)
        .executeTakeFirst();
      if (!hasAccounts) await seedLedger(tx, companyId!, userId);
    });

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

/** Demo lists and a few months of journal entries so reports have something to show. */
async function seedLedger(tx: Tx, companyId: string, userId: string): Promise<void> {
  await new LedgerSetupService().seedDefaults(tx, companyId, userId, 'form_1120s');
  const accounts = await tx
    .selectFrom('accounts')
    .select(['id', 'name'])
    .where('company_id', '=', companyId)
    .execute();
  const acct = (name: string) => accounts.find((a) => a.name === name)!.id;

  const [residential, commercial] = await Promise.all(
    ['Residential', 'Commercial'].map(
      async (name) =>
        (
          await tx
            .insertInto('classes')
            .values({ company_id: companyId, name })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id,
    ),
  );
  const customer = (
    await tx
      .insertInto('customers')
      .values({
        company_id: companyId,
        display_name: 'Hillside HOA',
        email: 'board@hillside.example',
        created_by: userId,
        updated_by: userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  await tx
    .insertInto('vendors')
    .values({
      company_id: companyId,
      display_name: 'Green Supply Co.',
      created_by: userId,
      updated_by: userId,
    })
    .execute();
  await tx
    .insertInto('items')
    .values({
      company_id: companyId,
      name: 'Weekly lawn service',
      item_type: 'service',
      sales_price: '85',
      income_account_id: acct('Services'),
      created_by: userId,
      updated_by: userId,
    })
    .execute();

  const posting = new PostingService();
  const year = new Date().getFullYear();
  const entry = async (
    date: string,
    memo: string,
    lines: Array<[string, 'Dr' | 'Cr', string, string?, string?]>,
  ) =>
    posting.create(
      tx,
      { companyId, userId },
      { txnType: 'journal_entry', txnDate: date, number: null, memo, isAdjusting: false },
      lines.map(([account, side, amount, classId, customerId]) => ({
        accountId: acct(account),
        debit: side === 'Dr' ? parseMoney(amount) : 0n,
        credit: side === 'Cr' ? parseMoney(amount) : 0n,
        description: null,
        customerId: customerId ?? null,
        vendorId: null,
        classId: classId ?? null,
        locationId: null,
      })),
    );
  await entry(`${year}-01-02`, 'Shareholder capital contribution', [
    ['Checking', 'Dr', '25000'],
    ['Common Stock', 'Cr', '25000'],
  ]);
  for (const [month, res, com] of [
    ['01', '6200', '3100'],
    ['02', '5800', '3400'],
    ['03', '7400', '4100'],
  ] as const) {
    await entry(`${year}-${month}-28`, 'Monthly service revenue', [
      ['Checking', 'Dr', String(Number(res) + Number(com))],
      ['Services', 'Cr', res, residential],
      ['Services', 'Cr', com, commercial],
    ]);
    await entry(`${year}-${month}-15`, 'Payroll', [
      ['Wages', 'Dr', '4200'],
      ['Payroll Taxes', 'Dr', '380'],
      ['Checking', 'Cr', '4580'],
    ]);
    await entry(`${year}-${month}-05`, 'Fuel and supplies', [
      ['Car and Truck', 'Dr', '410'],
      ['Cost of Goods Sold', 'Dr', '950'],
      ['Credit Card', 'Cr', '1360'],
    ]);
  }
  await entry(`${year}-03-31`, 'Invoice to Hillside HOA (pre-invoicing demo)', [
    ['Accounts Receivable (A/R)', 'Dr', '1200', residential, customer],
    ['Services', 'Cr', '1200', residential, customer],
  ]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
