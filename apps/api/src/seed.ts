/**
 * Development seed: a demo owner and the "Sample Landscaping Co." demo company.
 * Idempotent. Prints the demo MFA secret so it can be added to an authenticator app.
 * Refuses to run in production.
 */
import { randomUUID } from 'node:crypto';
import { generateTotp, generateTotpSecret, hashPassword, LocalAesGcmEncryptor } from '@acct/crypto';
import { createDb, withTenant, type Db, type Tx } from '@acct/db';
import { addDays, parseMoney } from '@acct/shared';
import { AuditService } from './audit/audit.service';
import type { AuthContext, CompanyContext } from './common/request';
import { loadConfig, type AppConfig } from './config';
import { InventoryService } from './inventory/inventory.service';
import { LedgerSetupService } from './ledger/ledger-setup.service';
import { PostingService } from './ledger/posting.service';
import type { Mailer } from './mail/mailer';
import { BillPaymentsService } from './purchases/bill-payments.service';
import { PurchaseDocumentsService } from './purchases/purchase-documents.service';
import { PurchaseOrdersService } from './purchases/purchase-orders.service';
import { DepositsService } from './sales/deposits.service';
import { BankFeedService } from './banking/bank-feed.service';
import { BankRulesService } from './banking/bank-rules.service';
import { TransfersService } from './banking/transfers.service';
import { createObjectStore, createVirusScanner } from './documents/documents.module';
import { DocumentsService } from './documents/documents.service';
import { HeuristicReceiptExtractor } from './documents/extraction/receipt-extractor';
import { makePdf } from './documents/pdf-fixture';
import { ReceiptsService } from './documents/receipts.service';
import { EstimatesService } from './sales/estimates.service';
import { PaymentsService } from './sales/payments.service';
import { RateTableCalculator } from './sales-tax/tax-calculator';
import { SalesDocumentsService } from './sales/sales-documents.service';
import { IMPORTED_COMPANY, seedMigration } from './seed-migration';
import { seedPhase7 } from './seed-phase7';
import { seedPhase8 } from './seed-phase8';
import { seedPhase10, seedPhase10b, seedPhase10c, seedPhase10d } from './seed-phase10';

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
    const hasSales = await withTenant(db, { userId, companyId }, (tx) =>
      tx
        .selectFrom('transactions')
        .select('id')
        .where('company_id', '=', companyId!)
        .where('txn_type', '=', 'invoice')
        .executeTakeFirst(),
    );
    if (!hasSales) await seedSales(db, config, userId, companyId!);
    const hasPurchases = await withTenant(db, { userId, companyId }, (tx) =>
      tx
        .selectFrom('transactions')
        .select('id')
        .where('company_id', '=', companyId!)
        .where('txn_type', '=', 'bill')
        .executeTakeFirst(),
    );
    if (!hasPurchases) await seedPurchases(db, userId, companyId!);
    const hasBanking = await withTenant(db, { userId, companyId }, (tx) =>
      tx
        .selectFrom('bank_feed_transactions')
        .select('id')
        .where('company_id', '=', companyId!)
        .executeTakeFirst(),
    );
    if (!hasBanking) await seedBanking(db, userId, companyId!);
    const hasDocuments = await withTenant(db, { userId, companyId }, (tx) =>
      tx
        .selectFrom('documents')
        .select('id')
        .where('company_id', '=', companyId!)
        .executeTakeFirst(),
    );
    if (!hasDocuments) await seedDocuments(db, config, enc, userId, companyId!);
    await seedPhase7(db, config, userId, companyId!);
    await seedPhase8(db, config, userId, companyId!);
    await seedPhase10(db, config, userId, companyId!);
    await seedPhase10b(db, config, userId, companyId!);
    await seedPhase10c(db, config, userId, companyId!);
    await seedPhase10d(db, config, userId, companyId!);
    await seedMigration(db, config, userId);

    console.log(
      [
        '',
        'Demo data ready.',
        `  Email:      ${DEMO_EMAIL}`,
        `  Password:   ${DEMO_PASSWORD}`,
        `  MFA secret: ${secret}  (add to an authenticator app)`,
        `  Current code: ${generateTotp(secret)}`,
        `  Also:       "${IMPORTED_COMPANY}", imported from the QuickBooks Online demo company`,
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
  await tx
    .insertInto('customers')
    .values({
      company_id: companyId,
      display_name: 'Hillside HOA',
      email: 'board@hillside.example',
      created_by: userId,
      updated_by: userId,
    })
    .execute();
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
    lines: Array<[string, 'Dr' | 'Cr', string, string?]>,
  ) =>
    posting.create(
      tx,
      { companyId, userId },
      { txnType: 'journal_entry', txnDate: date, number: null, memo, isAdjusting: false },
      lines.map(([account, side, amount, classId]) => ({
        accountId: acct(account),
        debit: side === 'Dr' ? parseMoney(amount) : 0n,
        credit: side === 'Cr' ? parseMoney(amount) : 0n,
        description: null,
        customerId: null,
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
}

/**
 * Demo sales: invoices (paid, partly paid, overdue), a deposit and an open estimate, created
 * through the same services the API uses, so postings and audit rows are real.
 */
async function seedSales(
  db: Db,
  config: AppConfig,
  userId: string,
  companyId: string,
): Promise<void> {
  const audit = new AuditService(db);
  const posting = new PostingService();
  const noMail: Mailer = { send: async () => undefined };
  const documents = new SalesDocumentsService(
    db,
    config,
    noMail,
    new RateTableCalculator(),
    posting,
    new InventoryService(posting),
    audit,
  );
  const payments = new PaymentsService(db, posting, audit);
  const deposits = new DepositsService(db, posting, audit);
  const estimates = new EstimatesService(db, noMail, new RateTableCalculator(), documents, audit);
  const auth = {
    userId,
    sessionId: 'seed',
    email: DEMO_EMAIL,
    fullName: 'Demo Owner',
    mfaEnrolled: true,
    mfaVerified: true,
  } as AuthContext;
  const ctx = { companyId, role: 'owner', permissions: [] } as unknown as CompanyContext;
  const meta = { ip: null, userAgent: 'seed', requestId: null };

  const { customers, items, accounts } = await withTenant(
    db,
    { userId, companyId },
    async (tx) => ({
      customers: await tx
        .selectFrom('customers')
        .select(['id', 'display_name'])
        .where('company_id', '=', companyId)
        .execute(),
      items: await tx
        .selectFrom('items')
        .select(['id', 'name'])
        .where('company_id', '=', companyId)
        .execute(),
      accounts: await tx
        .selectFrom('accounts')
        .select(['id', 'name'])
        .where('company_id', '=', companyId)
        .execute(),
    }),
  );
  const hillside = customers.find((c) => c.display_name === 'Hillside HOA')!.id;
  const lawn = items.find((i) => i.name === 'Weekly lawn service')!.id;
  const acct = (name: string) => accounts.find((a) => a.name === name)!.id;
  const oakwood = await withTenant(
    db,
    { userId, companyId },
    async (tx) =>
      (
        await tx
          .insertInto('customers')
          .values({
            company_id: companyId,
            display_name: 'Oakwood Dental',
            email: 'office@oakwood.example',
            created_by: userId,
            updated_by: userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id,
  );

  const year = new Date().getFullYear();
  const invoice = (
    customerId: string,
    date: string,
    due: string,
    lines: Array<Record<string, unknown>>,
  ) =>
    documents.save(
      auth,
      ctx,
      'invoice',
      null,
      { customerId, txnDate: date, dueDate: due, lines },
      meta,
    );

  const jan = await invoice(hillside, `${year}-01-31`, `${year}-03-02`, [
    { itemId: lawn, quantity: '4', rate: '85' },
    { accountId: acct('Services'), description: 'Spring cleanup', amount: '450' },
  ]);
  const feb = await invoice(oakwood, `${year}-02-28`, `${year}-03-30`, [
    { itemId: lawn, quantity: '4', rate: '85' },
  ]);
  await invoice(hillside, `${year}-03-31`, `${year}-04-30`, [
    { itemId: lawn, quantity: '5', rate: '85' },
    { accountId: acct('Services'), description: 'Irrigation repair', amount: '275' },
  ]);

  const p1 = await payments.save(
    auth,
    ctx,
    null,
    {
      customerId: hillside,
      txnDate: `${year}-02-20`,
      amount: jan.total,
      reference: '2231',
      applications: [{ targetId: jan.id, amount: jan.total }],
    },
    meta,
  );
  const p2 = await payments.save(
    auth,
    ctx,
    null,
    {
      customerId: oakwood,
      txnDate: `${year}-03-25`,
      amount: '200',
      reference: '8817',
      applications: [{ targetId: feb.id, amount: '200' }],
    },
    meta,
  );
  await deposits.save(
    auth,
    ctx,
    null,
    {
      txnDate: `${year}-03-26`,
      depositAccountId: acct('Checking'),
      lines: [{ sourceTxnId: p1.id }, { sourceTxnId: p2.id }],
    },
    meta,
  );

  await estimates.save(
    auth,
    ctx,
    null,
    {
      customerId: oakwood,
      txnDate: `${year}-04-02`,
      expirationDate: `${year}-05-02`,
      lines: [
        {
          accountId: acct('Services'),
          description: 'Front bed redesign and planting',
          amount: '1850',
        },
      ],
    },
    meta,
  );
}

/**
 * Demo purchases: a paid and an unpaid bill, a check waiting to be printed, a credit card
 * expense, an open purchase order and a 1099 contractor, created through the purchase services.
 */
async function seedPurchases(db: Db, userId: string, companyId: string): Promise<void> {
  const audit = new AuditService(db);
  const posting = new PostingService();
  const documents = new PurchaseDocumentsService(db, posting, new InventoryService(posting), audit);
  const payments = new BillPaymentsService(db, posting, audit);
  const orders = new PurchaseOrdersService(db, documents, audit);
  const auth = {
    userId,
    sessionId: 'seed',
    email: DEMO_EMAIL,
    fullName: 'Demo Owner',
    mfaEnrolled: true,
    mfaVerified: true,
  } as AuthContext;
  const ctx = { companyId, role: 'owner', permissions: [] } as unknown as CompanyContext;
  const meta = { ip: null, userAgent: 'seed', requestId: null };

  const { vendors, accounts } = await withTenant(db, { userId, companyId }, async (tx) => ({
    vendors: await tx
      .selectFrom('vendors')
      .select(['id', 'display_name'])
      .where('company_id', '=', companyId)
      .execute(),
    accounts: await tx
      .selectFrom('accounts')
      .select(['id', 'name'])
      .where('company_id', '=', companyId)
      .execute(),
  }));
  const acct = (name: string) => accounts.find((a) => a.name === name)!.id;
  const supply = vendors.find((v) => v.display_name === 'Green Supply Co.')!.id;
  const rivera = await withTenant(db, { userId, companyId }, async (tx) => {
    const id = (
      await tx
        .insertInto('vendors')
        .values({
          company_id: companyId,
          display_name: 'Rivera Tree Service',
          is_1099: true,
          address_line1: '41 Oak Ln',
          city: 'Austin',
          state: 'TX',
          postal_code: '78704',
          created_by: userId,
          updated_by: userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await tx
      .insertInto('vendor_1099_accounts')
      .values({ company_id: companyId, account_id: acct('Contract Labor'), box: 'nec_1' })
      .execute();
    return id;
  });

  const year = new Date().getFullYear();
  const paid = await documents.save(
    auth,
    ctx,
    'bill',
    null,
    {
      vendorId: supply,
      txnDate: `${year}-01-20`,
      dueDate: `${year}-02-19`,
      number: 'GS-2041',
      lines: [
        {
          accountId: acct('Cost of Goods Sold'),
          description: 'Mulch and spring plants',
          amount: '1250',
        },
      ],
    },
    meta,
  );
  await payments.save(
    auth,
    ctx,
    null,
    {
      vendorId: supply,
      txnDate: `${year}-02-10`,
      paymentAccountId: acct('Checking'),
      number: '1001',
      applications: [{ targetId: paid.id, amount: '1250' }],
    },
    meta,
  );
  await documents.save(
    auth,
    ctx,
    'bill',
    null,
    {
      vendorId: supply,
      txnDate: `${year}-03-18`,
      dueDate: `${year}-04-17`,
      number: 'GS-2107',
      lines: [
        {
          accountId: acct('Repairs and Maintenance'),
          description: 'Mower blades and belts',
          amount: '380',
        },
      ],
    },
    meta,
  );
  await documents.save(
    auth,
    ctx,
    'check',
    null,
    {
      vendorId: rivera,
      txnDate: `${year}-03-05`,
      paymentAccountId: acct('Checking'),
      printLater: true,
      memo: 'Oak removal, Hillside HOA',
      lines: [
        { accountId: acct('Contract Labor'), description: 'Tree removal crew', amount: '1800' },
      ],
    },
    meta,
  );
  await documents.save(
    auth,
    ctx,
    'expense',
    null,
    {
      txnDate: `${year}-03-12`,
      paymentAccountId: acct('Credit Card'),
      lines: [
        {
          accountId: acct('Office Supplies and Software'),
          description: 'Scheduling software',
          amount: '129.99',
        },
      ],
    },
    meta,
  );
  await orders.save(
    auth,
    ctx,
    null,
    {
      vendorId: supply,
      txnDate: `${year}-04-01`,
      expectedDate: `${year}-04-15`,
      lines: [
        {
          accountId: acct('Cost of Goods Sold'),
          description: 'Perennials for spring installs',
          amount: '900',
        },
      ],
    },
    meta,
  );
}

/**
 * A card payment (transfer), two bank rules and an uploaded May statement for Checking: one line
 * matches the transfer, one the check paid in Phase 3's demo, one is auto-added by a rule and the
 * rest wait in For Review.
 */
async function seedBanking(db: Db, userId: string, companyId: string): Promise<void> {
  const audit = new AuditService(db);
  const posting = new PostingService();
  const purchases = new PurchaseDocumentsService(db, posting, new InventoryService(posting), audit);
  const deposits = new DepositsService(db, posting, audit);
  const transfers = new TransfersService(db, posting, audit);
  const feed = new BankFeedService(db, audit, posting, purchases, deposits, transfers);
  const rules = new BankRulesService(db, audit);
  const auth = {
    userId,
    sessionId: 'seed',
    email: DEMO_EMAIL,
    fullName: 'Demo Owner',
    mfaEnrolled: true,
    mfaVerified: true,
  } as AuthContext;
  const ctx = { companyId, role: 'owner', permissions: [] } as unknown as CompanyContext;
  const meta = { ip: null, userAgent: 'seed', requestId: null };
  const year = new Date().getFullYear();
  const { accounts, check } = await withTenant(db, { userId, companyId }, async (tx) => ({
    accounts: await tx
      .selectFrom('accounts')
      .select(['id', 'name'])
      .where('company_id', '=', companyId)
      .execute(),
    check: await tx
      .selectFrom('transactions')
      .select(['txn_number', 'total', 'txn_date'])
      .where('company_id', '=', companyId)
      .where('txn_type', 'in', ['check', 'bill_payment'])
      .where('txn_number', '=', '1001')
      .where('status', '=', 'posted')
      .executeTakeFirst(),
  }));
  const acct = (name: string) => accounts.find((a) => a.name === name)!.id;

  await transfers.save(
    auth,
    ctx,
    null,
    {
      fromAccountId: acct('Checking'),
      toAccountId: acct('Credit Card'),
      txnDate: `${year}-05-05`,
      amount: '400',
      memo: 'Credit card payment',
    },
    meta,
  );
  const rule = (name: string, text: string, account: string, autoAdd: boolean) =>
    rules.save(
      auth,
      ctx,
      null,
      {
        name,
        priority: 100,
        direction: 'out',
        accountIds: [],
        matchAll: true,
        conditions: [{ field: 'description', operator: 'contains', value: text }],
        action: 'categorize',
        accountId: acct(account),
        autoAdd,
        isActive: true,
      },
      meta,
    );
  await rule('Fuel', 'shell', 'Car and Truck', false);
  await rule('Bank fees', 'service fee', 'Bank Charges and Fees', true);

  const d = (day: string) => `${year}05${day}`;
  const txn = (fitId: string, date: string, amount: string, name: string, checkNum?: string) =>
    `<STMTTRN><TRNTYPE>${amount.startsWith('-') ? 'DEBIT' : 'CREDIT'}<DTPOSTED>${date}<TRNAMT>${amount}` +
    `<FITID>${fitId}${checkNum ? `<CHECKNUM>${checkNum}` : ''}<NAME>${name}</STMTTRN>`;
  const lines = [
    txn('SEED-1', d('06'), '-400.00', 'ONLINE TRANSFER TO CARD'),
    txn('SEED-2', d('09'), '-58.40', 'SHELL OIL 57442'),
    txn('SEED-3', d('15'), '-15.00', 'MONTHLY SERVICE FEE'),
    txn('SEED-4', d('18'), '-129.99', 'HOME DEPOT #4410'),
    txn('SEED-5', d('21'), '1450.00', 'ACH DEPOSIT HILLSIDE HOA'),
  ];
  if (check?.total)
    lines.push(
      txn(
        'SEED-6',
        addDays(check.txn_date, 7).replace(/-/g, ''),
        `-${check.total}`,
        'CHECK 1001',
        '1001',
      ),
    );
  const ofx = `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD
<BANKACCTFROM><BANKID>121000248<ACCTID>000123451234<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>${lines.join('\n')}</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  await feed.importFile(
    auth,
    ctx,
    acct('Checking'),
    { fileName: 'May statement.qbo', content: ofx },
    meta,
  );
}

/**
 * A contract in a folder, a W-9 on a vendor, a receipt on the card expense, and two documents
 * waiting in the receipts inbox (read with the text heuristics).
 */
async function seedDocuments(
  db: Db,
  config: AppConfig,
  enc: LocalAesGcmEncryptor,
  userId: string,
  companyId: string,
): Promise<void> {
  const audit = new AuditService(db);
  const posting = new PostingService();
  const documents = new DocumentsService(
    db,
    config,
    createObjectStore(config, enc),
    createVirusScanner(config),
    audit,
  );
  const receipts = new ReceiptsService(
    db,
    new HeuristicReceiptExtractor(),
    documents,
    new PurchaseDocumentsService(db, posting, new InventoryService(posting), audit),
    audit,
  );
  const auth = {
    userId,
    sessionId: 'seed',
    email: DEMO_EMAIL,
    fullName: 'Demo Owner',
    mfaEnrolled: true,
    mfaVerified: true,
  } as AuthContext;
  const ctx = { companyId, role: 'owner', permissions: [] } as unknown as CompanyContext;
  const meta = { ip: null, userAgent: 'seed', requestId: null };
  const actor = { userId, companyId };
  const year = new Date().getFullYear();
  const { vendor, expense } = await withTenant(db, actor, async (tx) => ({
    vendor: await tx
      .selectFrom('vendors')
      .select('id')
      .where('company_id', '=', companyId)
      .where('display_name', '=', 'Green Supply Co.')
      .executeTakeFirst(),
    expense: await tx
      .selectFrom('transactions')
      .select('id')
      .where('company_id', '=', companyId)
      .where('txn_type', '=', 'expense')
      .where('status', '=', 'posted')
      .executeTakeFirst(),
  }));

  const contracts = await documents.saveFolder(auth, ctx, null, { name: 'Contracts' }, meta);
  await documents.saveFolder(auth, ctx, null, { name: 'Tax records' }, meta);
  const lease = await documents.ingest(
    actor,
    makePdf([
      'Commercial lease',
      'Sample Landscaping Co.',
      `Term: January 1, ${year} to December 31, ${year}`,
      'Rent $2,400.00 per month',
    ]),
    { fileName: 'Yard lease.pdf', folderId: contracts.id, source: 'upload' },
    meta,
  );
  await documents.update(auth, ctx, lease.id, { tags: ['lease', 'contracts'] }, meta);
  if (vendor) {
    await documents.ingest(
      actor,
      makePdf(['Form W-9', 'Green Supply Co.', 'EIN on file']),
      {
        fileName: 'W-9 Green Supply.pdf',
        link: { entityType: 'vendor', entityId: vendor.id },
        source: 'upload',
      },
      meta,
    );
  }
  if (expense) {
    await documents.ingest(
      actor,
      makePdf(['Shell', 'Fuel', 'Total $64.12']),
      {
        fileName: 'Fuel receipt.pdf',
        link: { entityType: 'transaction', entityId: expense.id },
        source: 'camera',
      },
      meta,
    );
  }
  for (const [name, lines] of [
    [
      'Home Depot receipt.pdf',
      [
        'The Home Depot #4410',
        `05/18/${year} 14:02`,
        'Mulch 10 bags $49.90',
        'Sales Tax $4.12',
        'TOTAL $54.02',
        'VISA ****1234',
      ],
    ],
    [
      'Green Supply invoice GS-5520.pdf',
      [
        'Green Supply Co.',
        'INVOICE',
        'Invoice No: GS-5520',
        `Invoice date: 06/01/${year}`,
        `Due date: 07/01/${year}`,
        'Perennials $640.00',
        'Amount due $640.00',
      ],
    ],
  ] as const) {
    const doc = await documents.ingest(
      actor,
      makePdf([...lines]),
      { fileName: name, inbox: true, source: 'upload' },
      meta,
    );
    await receipts.read(userId, companyId, doc.id, meta);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
