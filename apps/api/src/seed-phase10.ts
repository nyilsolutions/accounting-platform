import { NestFactory } from '@nestjs/core';
import { withTenant, type Db } from '@acct/db';
import {
  estimateInputSchema,
  inventoryAdjustmentInputSchema,
  progressInvoiceSchema,
  timeEntryInputSchema,
  timesheetInputSchema,
  weekOf,
  inventoryBuildInputSchema,
  billPaymentInputSchema,
  accountInputSchema,
  customerInputSchema,
  depositInputSchema,
  journalEntryInputSchema,
  itemInputSchema,
  paymentInputSchema,
  PERMISSIONS,
  addDays,
  todayIso,
  vendorInputSchema,
  purchaseDocumentInputSchema,
  salesDocumentInputSchema,
} from '@acct/shared';
import { AppModule } from './app.module';
import { CurrencyService } from './currency/currency.service';
import { AccountsService } from './ledger/accounts.service';
import { JournalService } from './ledger/journal.service';
import { DepositsService } from './sales/deposits.service';
import { CustomersService, VendorsService } from './lists/customers-vendors.service';
import { PaymentsService } from './sales/payments.service';
import { BillPaymentsService } from './purchases/bill-payments.service';
import type { AuthContext, CompanyContext, RequestMeta } from './common/request';
import type { AppConfig } from './config';
import { InventoryDocumentsService } from './inventory/inventory-documents.service';
import { ItemsService } from './lists/other-lists.service';
import { PurchaseDocumentsService } from './purchases/purchase-documents.service';
import { EstimatesService } from './sales/estimates.service';
import { SalesDocumentsService } from './sales/sales-documents.service';
import { TimeService } from './time/time.service';
import { OnlinePaymentsService } from './online-payments/online-payments.service';
import { PaymentEventsService } from './online-payments/payment-events.service';
import { PublicPayService } from './online-payments/public-pay.service';
import { WorkerPortalService } from './portals/worker-portal.service';

/**
 * Demo of Phase 10a inventory in Sample Landscaping Co. (FIFO, the default):
 * - paver stones and polymeric sand bought from Green Supply Co. in August and September (the
 *   pavers at two prices, so FIFO layers show);
 * - a "Patio paver kit" assembly (40 pavers and 2 bags of sand), five built in September;
 * - an invoice to Hillside HOA for a kit and 60 extra pavers;
 * - 12 broken pavers written off.
 * Sand ends below its reorder point, so it shows as needing a reorder.
 */
export async function seedPhase10(
  db: Db,
  config: AppConfig,
  userId: string,
  companyId: string,
): Promise<void> {
  const lookup = await withTenant(db, { userId, companyId }, async (tx) => ({
    done: await tx
      .selectFrom('items')
      .select('id')
      .where('company_id', '=', companyId)
      .where('name', '=', 'Paver stone')
      .executeTakeFirst(),
    accounts: await tx
      .selectFrom('accounts')
      .select(['id', 'name'])
      .where('company_id', '=', companyId)
      .execute(),
    supply: await tx
      .selectFrom('vendors')
      .select('id')
      .where('company_id', '=', companyId)
      .where('display_name', '=', 'Green Supply Co.')
      .executeTakeFirst(),
    hillside: await tx
      .selectFrom('customers')
      .select('id')
      .where('company_id', '=', companyId)
      .where('display_name', '=', 'Hillside HOA')
      .executeTakeFirst(),
  }));
  if (lookup.done || !lookup.supply || !lookup.hillside) return;
  const acct = (name: string) => lookup.accounts.find((a) => a.name === name)!.id;

  const app = await NestFactory.createApplicationContext(
    AppModule.forRoot({ ...config, JOB_WORKER: 'off' }),
    { logger: ['error'] },
  );
  try {
    const auth: AuthContext = {
      sessionId: 'seed',
      userId,
      email: 'demo@example.com',
      fullName: 'Demo Owner',
      mfaEnrolled: true,
      mfaVerified: true,
    };
    const ctx: CompanyContext = { companyId, role: 'owner', permissions: PERMISSIONS };
    const meta: RequestMeta = { ip: null, userAgent: 'seed', requestId: null };
    const year = new Date().getFullYear();
    const items = app.get(ItemsService);
    const purchases = app.get(PurchaseDocumentsService);
    const sales = app.get(SalesDocumentsService);
    const inventory = app.get(InventoryDocumentsService);

    const paver = await items.save(
      auth,
      ctx,
      null,
      itemInputSchema.parse({
        name: 'Paver stone',
        sku: 'PAV-1212',
        itemType: 'inventory',
        description: '12 × 12 in concrete paver',
        salesPrice: '6',
        incomeAccountId: acct('Sales'),
        cost: '2.50',
        reorderPoint: '100',
        taxable: true,
      }),
      meta,
    );
    const sand = await items.save(
      auth,
      ctx,
      null,
      itemInputSchema.parse({
        name: 'Polymeric sand (50 lb)',
        sku: 'SAND-50',
        itemType: 'inventory',
        salesPrice: '32',
        incomeAccountId: acct('Sales'),
        cost: '18',
        reorderPoint: '10',
        taxable: true,
      }),
      meta,
    );
    const kit = await items.save(
      auth,
      ctx,
      null,
      itemInputSchema.parse({
        name: 'Patio paver kit',
        itemType: 'assembly',
        description: '40 pavers and 2 bags of polymeric sand (about 40 sq ft)',
        salesPrice: '295',
        incomeAccountId: acct('Sales'),
        taxable: true,
        components: [
          { componentId: paver.id, quantity: '40' },
          { componentId: sand.id, quantity: '2' },
        ],
      }),
      meta,
    );

    const bill = (date: string, number: string, lines: Array<Record<string, unknown>>) =>
      purchases.save(
        auth,
        ctx,
        'bill',
        null,
        purchaseDocumentInputSchema.parse({
          vendorId: lookup.supply!.id,
          txnDate: date,
          number,
          lines,
        }),
        meta,
      );
    await bill(`${year}-08-04`, 'GS-2231', [
      { itemId: paver.id, quantity: '300', rate: '2.50' },
      { itemId: sand.id, quantity: '12', rate: '18' },
    ]);
    await bill(`${year}-09-02`, 'GS-2310', [{ itemId: paver.id, quantity: '200', rate: '2.75' }]);

    await inventory.saveBuild(
      auth,
      ctx,
      null,
      inventoryBuildInputSchema.parse({
        txnDate: `${year}-09-08`,
        number: 'KIT-1',
        assemblyId: kit.id,
        quantity: '5',
      }),
      meta,
    );
    await sales.save(
      auth,
      ctx,
      'invoice',
      null,
      salesDocumentInputSchema.parse({
        customerId: lookup.hillside!.id,
        txnDate: `${year}-09-15`,
        dueDate: `${year}-10-15`,
        lines: [
          { itemId: kit.id, quantity: '1', rate: '295' },
          { itemId: paver.id, quantity: '60', rate: '6' },
        ],
      }),
      meta,
    );
    await inventory.saveAdjustment(
      auth,
      ctx,
      null,
      inventoryAdjustmentInputSchema.parse({
        txnDate: `${year}-09-20`,
        number: 'ADJ-1',
        memo: 'Pavers broken in the yard',
        accountId: acct('Cost of Goods Sold'),
        lines: [{ itemId: paver.id, quantityChange: '-12' }],
      }),
      meta,
    );
  } finally {
    await app.close();
  }
}

/**
 * Demo of Phase 10b in Sample Landscaping Co.:
 * - Maria Lopez's timesheet for the last full week of September, approved: lawn service for
 *   Hillside HOA (billable, not billed yet) and shop time;
 * - Rivera Tree Service's four billable hours for Hillside HOA, approved;
 * - Maria's next week, submitted and waiting for approval;
 * - an estimate for Oakwood Dental's front garden, with a 40% progress invoice.
 */
export async function seedPhase10b(
  db: Db,
  config: AppConfig,
  userId: string,
  companyId: string,
): Promise<void> {
  const lookup = await withTenant(db, { userId, companyId }, async (tx) => ({
    done: await tx
      .selectFrom('time_entries')
      .select('id')
      .where('company_id', '=', companyId)
      .executeTakeFirst(),
    maria: await tx
      .selectFrom('employees')
      .select('id')
      .where('company_id', '=', companyId)
      .where('first_name', '=', 'Maria')
      .executeTakeFirst(),
    rivera: await tx
      .selectFrom('vendors')
      .select('id')
      .where('company_id', '=', companyId)
      .where('display_name', '=', 'Rivera Tree Service')
      .executeTakeFirst(),
    customers: await tx
      .selectFrom('customers')
      .select(['id', 'display_name'])
      .where('company_id', '=', companyId)
      .execute(),
    lawn: await tx
      .selectFrom('items')
      .select('id')
      .where('company_id', '=', companyId)
      .where('name', '=', 'Weekly lawn service')
      .executeTakeFirst(),
    accounts: await tx
      .selectFrom('accounts')
      .select(['id', 'name'])
      .where('company_id', '=', companyId)
      .execute(),
  }));
  const hillside = lookup.customers.find((c) => c.display_name === 'Hillside HOA');
  const oakwood = lookup.customers.find((c) => c.display_name === 'Oakwood Dental');
  if (lookup.done || !lookup.maria || !lookup.rivera || !hillside || !oakwood || !lookup.lawn)
    return;
  const acct = (name: string) => lookup.accounts.find((a) => a.name === name)!.id;

  const app = await NestFactory.createApplicationContext(
    AppModule.forRoot({ ...config, JOB_WORKER: 'off' }),
    { logger: ['error'] },
  );
  try {
    const auth: AuthContext = {
      sessionId: 'seed',
      userId,
      email: 'demo@example.com',
      fullName: 'Demo Owner',
      mfaEnrolled: true,
      mfaVerified: true,
    };
    const ctx: CompanyContext = { companyId, role: 'owner', permissions: PERMISSIONS };
    const meta: RequestMeta = { ip: null, userAgent: 'seed', requestId: null };
    const year = new Date().getFullYear();
    const time = app.get(TimeService);
    const week1 = weekOf(`${year}-09-21`).start;
    const week2 = weekOf(`${year}-09-28`).start;

    await time.saveTimesheet(
      auth,
      ctx,
      timesheetInputSchema.parse({
        employeeId: lookup.maria.id,
        weekStart: week1,
        rows: [
          {
            customerId: hillside.id,
            itemId: lookup.lawn.id,
            billable: true,
            hours: ['6', '6', '', '6', '', '', ''],
          },
          { notes: 'Equipment maintenance', hours: ['2', '2', '8', '2', '8', '', ''] },
        ],
      }),
      meta,
    );
    await time.submit(auth, ctx, { employeeId: lookup.maria.id, weekStart: week1 }, meta);
    const entry = await time.create(
      auth,
      ctx,
      timeEntryInputSchema.parse({
        vendorId: lookup.rivera.id,
        workDate: week1,
        hours: '4',
        customerId: hillside.id,
        itemId: lookup.lawn.id,
        billable: true,
        billingRate: '75',
        notes: 'Oak trimming along the entrance',
      }),
      meta,
    );
    await time.submit(auth, ctx, { vendorId: lookup.rivera.id, weekStart: week1 }, meta);
    const submitted = await time.list(auth, ctx, { status: 'submitted' });
    await time.approve(
      auth,
      ctx,
      [...submitted.map((e) => e.id), entry.id].filter((v, i, a) => a.indexOf(v) === i),
      meta,
    );

    await time.saveTimesheet(
      auth,
      ctx,
      timesheetInputSchema.parse({
        employeeId: lookup.maria.id,
        weekStart: week2,
        rows: [
          {
            customerId: hillside.id,
            itemId: lookup.lawn.id,
            billable: true,
            hours: ['7', '7', '7', '', '', '', ''],
          },
        ],
      }),
      meta,
    );
    await time.submit(auth, ctx, { employeeId: lookup.maria.id, weekStart: week2 }, meta);

    const estimates = app.get(EstimatesService);
    const estimate = await estimates.save(
      auth,
      ctx,
      null,
      estimateInputSchema.parse({
        customerId: oakwood.id,
        txnDate: `${year}-09-02`,
        status: 'accepted',
        lines: [
          { accountId: acct('Services'), description: 'Front garden design', amount: '1200' },
          {
            accountId: acct('Services'),
            description: 'Planting and hardscape labor',
            quantity: '40',
            rate: '60',
          },
        ],
      }),
      meta,
    );
    await estimates.progressInvoice(
      auth,
      ctx,
      estimate.id,
      progressInvoiceSchema.parse({ txnDate: `${year}-09-10`, mode: 'percent', percent: '40' }),
      meta,
    );
  } finally {
    await app.close();
  }
}

/**
 * Demo of Phase 10c multi-currency in Sample Landscaping Co. (multi-currency on, CAD and EUR):
 * - rates for the end of August and through September;
 * - Maple Leaf Gardens Ltd. (Canadian dollars): two September invoices, the first paid at a
 *   better rate (a realized gain), the second open;
 * - Hortus Seeds B.V. (euros): a bill for bulbs, paid at a worse rate (a realized loss).
 * Revaluing at September 30 then shows the open Canadian invoice's unrealized gain or loss.
 */
export async function seedPhase10c(
  db: Db,
  config: AppConfig,
  userId: string,
  companyId: string,
): Promise<void> {
  const lookup = await withTenant(db, { userId, companyId }, async (tx) => ({
    done: await tx
      .selectFrom('company_currencies')
      .select('currency')
      .where('company_id', '=', companyId)
      .executeTakeFirst(),
    accounts: await tx
      .selectFrom('accounts')
      .select(['id', 'name'])
      .where('company_id', '=', companyId)
      .execute(),
    lawn: await tx
      .selectFrom('items')
      .select('id')
      .where('company_id', '=', companyId)
      .where('name', '=', 'Weekly lawn service')
      .executeTakeFirst(),
  }));
  if (lookup.done || !lookup.lawn) return;
  const acct = (name: string) => lookup.accounts.find((a) => a.name === name)!.id;

  const app = await NestFactory.createApplicationContext(
    AppModule.forRoot({ ...config, JOB_WORKER: 'off' }),
    { logger: ['error'] },
  );
  try {
    const auth: AuthContext = {
      sessionId: 'seed',
      userId,
      email: 'demo@example.com',
      fullName: 'Demo Owner',
      mfaEnrolled: true,
      mfaVerified: true,
    };
    const ctx: CompanyContext = { companyId, role: 'owner', permissions: PERMISSIONS };
    const meta: RequestMeta = { ip: null, userAgent: 'seed', requestId: null };
    const year = new Date().getFullYear();
    const currencies = app.get(CurrencyService);
    await currencies.enable(auth, ctx, meta);
    await currencies.addCurrency(auth, ctx, 'CAD', meta);
    await currencies.addCurrency(auth, ctx, 'EUR', meta);
    // Illustrative rates (US dollars per unit), entered by hand.
    const rates: Array<[string, string, string]> = [
      ['CAD', `${year}-08-31`, '0.7310'],
      ['CAD', `${year}-09-15`, '0.7385'],
      ['CAD', `${year}-09-30`, '0.7342'],
      ['EUR', `${year}-08-31`, '1.0820'],
      ['EUR', `${year}-09-15`, '1.0905'],
      ['EUR', `${year}-09-30`, '1.0870'],
    ];
    for (const [currency, rateDate, rate] of rates)
      await currencies.saveRate(auth, ctx, { currency, rateDate, rate }, meta);

    const maple = await app.get(CustomersService).save(
      auth,
      ctx,
      null,
      customerInputSchema.parse({
        displayName: 'Maple Leaf Gardens Ltd.',
        companyName: 'Maple Leaf Gardens Ltd.',
        city: 'Windsor',
        state: null,
        currency: 'CAD',
      }),
      meta,
    );
    const hortus = await app.get(VendorsService).save(
      auth,
      ctx,
      null,
      vendorInputSchema.parse({
        displayName: 'Hortus Seeds B.V.',
        companyName: 'Hortus Seeds B.V.',
        currency: 'EUR',
      }),
      meta,
    );

    const sales = app.get(SalesDocumentsService);
    const invoice = (date: string, number: string, amount: string) =>
      sales.save(
        auth,
        ctx,
        'invoice',
        null,
        salesDocumentInputSchema.parse({
          customerId: maple.id,
          txnDate: date,
          number,
          lines: [
            {
              itemId: lookup.lawn!.id,
              description: 'Grounds maintenance, Windsor site',
              amount,
            },
          ],
        }),
        meta,
      );
    const first = await invoice(`${year}-09-01`, 'CA-1001', '2400');
    await invoice(`${year}-09-16`, 'CA-1002', '1850');
    await app.get(PaymentsService).save(
      auth,
      ctx,
      null,
      paymentInputSchema.parse({
        customerId: maple.id,
        txnDate: `${year}-09-20`,
        amount: '2400',
        exchangeRate: '0.7402',
        depositAccountId: acct('Checking'),
        reference: 'EFT 55821',
        applications: [{ targetId: first.id, amount: '2400' }],
      }),
      meta,
    );

    const purchases = app.get(PurchaseDocumentsService);
    const bill = await purchases.save(
      auth,
      ctx,
      'bill',
      null,
      purchaseDocumentInputSchema.parse({
        vendorId: hortus.id,
        txnDate: `${year}-09-02`,
        number: 'HS-3391',
        lines: [
          {
            accountId: acct('Cost of Goods Sold'),
            description: 'Tulip bulbs, 20 crates',
            amount: '1500',
          },
        ],
      }),
      meta,
    );
    await app.get(BillPaymentsService).save(
      auth,
      ctx,
      null,
      billPaymentInputSchema.parse({
        vendorId: hortus.id,
        txnDate: `${year}-09-25`,
        paymentAccountId: acct('Checking'),
        number: 'WIRE-0925',
        exchangeRate: '1.0935',
        applications: [{ targetId: bill.id, amount: '1500' }],
      }),
      meta,
    );
  } finally {
    await app.close();
  }
}

/**
 * Demo of Phase 10d accountant tools in Sample Landscaping Co.:
 * - an adjusting entry accruing August utilities (Adjusted Trial Balance);
 * - an old $85 invoice to Oakwood Dental nobody will pay (Write off invoices);
 * - a $320 payment from Hillside HOA received into Undeposited Funds, with the bank deposit
 *   entered again straight to Services (Fix undeposited funds);
 * - a $64.50 expense left in Uncategorized Expense (Reclassify, and the close checklist).
 */
export async function seedPhase10d(
  db: Db,
  config: AppConfig,
  userId: string,
  companyId: string,
): Promise<void> {
  const lookup = await withTenant(db, { userId, companyId }, async (tx) => ({
    done: await tx
      .selectFrom('transactions')
      .select('id')
      .where('company_id', '=', companyId)
      .where('memo', '=', 'Accrue August utilities')
      .executeTakeFirst(),
    accounts: await tx
      .selectFrom('accounts')
      .select(['id', 'name'])
      .where('company_id', '=', companyId)
      .execute(),
    customers: await tx
      .selectFrom('customers')
      .select(['id', 'display_name'])
      .where('company_id', '=', companyId)
      .execute(),
  }));
  const hillside = lookup.customers.find((c) => c.display_name === 'Hillside HOA');
  const oakwood = lookup.customers.find((c) => c.display_name === 'Oakwood Dental');
  if (lookup.done || !hillside || !oakwood) return;
  const acct = (name: string) => lookup.accounts.find((a) => a.name === name)!.id;

  const app = await NestFactory.createApplicationContext(
    AppModule.forRoot({ ...config, JOB_WORKER: 'off' }),
    { logger: ['error'] },
  );
  try {
    const auth: AuthContext = {
      sessionId: 'seed',
      userId,
      email: 'demo@example.com',
      fullName: 'Demo Owner',
      mfaEnrolled: true,
      mfaVerified: true,
    };
    const ctx: CompanyContext = { companyId, role: 'owner', permissions: PERMISSIONS };
    const meta: RequestMeta = { ip: null, userAgent: 'seed', requestId: null };
    const year = new Date().getFullYear();

    const accrued = await app.get(AccountsService).create(
      auth,
      ctx,
      accountInputSchema.parse({
        name: 'Accrued Liabilities',
        accountType: 'other_current_liability',
        description: 'Expenses incurred, not yet billed',
      }),
      meta,
    );
    await app.get(JournalService).create(
      auth,
      ctx,
      journalEntryInputSchema.parse({
        txnDate: `${year}-08-31`,
        isAdjusting: true,
        memo: 'Accrue August utilities',
        lines: [
          {
            accountId: acct('Utilities'),
            debit: '215.40',
            description: 'August electric and water',
          },
          { accountId: accrued.id, credit: '215.40' },
        ],
      }),
      meta,
    );

    const sales = app.get(SalesDocumentsService);
    await sales.save(
      auth,
      ctx,
      'invoice',
      null,
      salesDocumentInputSchema.parse({
        customerId: oakwood.id,
        txnDate: `${year}-03-05`,
        dueDate: `${year}-04-04`,
        number: 'OLD-17',
        memo: 'Hedge trim, disputed',
        lines: [{ accountId: acct('Services'), description: 'Hedge trim', amount: '85' }],
      }),
      meta,
    );

    const invoice = await sales.save(
      auth,
      ctx,
      'invoice',
      null,
      salesDocumentInputSchema.parse({
        customerId: hillside.id,
        txnDate: `${year}-09-05`,
        lines: [{ accountId: acct('Services'), description: 'Irrigation repair', amount: '320' }],
      }),
      meta,
    );
    await app.get(PaymentsService).save(
      auth,
      ctx,
      null,
      paymentInputSchema.parse({
        customerId: hillside.id,
        txnDate: `${year}-09-12`,
        amount: '320',
        reference: 'Check 4471',
        applications: [{ targetId: invoice.id, amount: '320' }],
      }),
      meta,
    );
    await app.get(DepositsService).save(
      auth,
      ctx,
      null,
      depositInputSchema.parse({
        txnDate: `${year}-09-13`,
        depositAccountId: acct('Checking'),
        memo: 'Hillside check',
        lines: [{ accountId: acct('Services'), amount: '320', customerId: hillside.id }],
      }),
      meta,
    );

    await app.get(PurchaseDocumentsService).save(
      auth,
      ctx,
      'expense',
      null,
      purchaseDocumentInputSchema.parse({
        txnDate: `${year}-09-18`,
        paymentAccountId: acct('Checking'),
        memo: 'Card swipe, unknown',
        lines: [
          {
            accountId: acct('Uncategorized Expense'),
            description: 'HOMEDEPOT #4410',
            amount: '64.50',
          },
        ],
      }),
      meta,
    );
  } finally {
    await app.close();
  }
}

/**
 * Demo of Phase 10e online payments in Sample Landscaping Co., through the Stripe stand-in
 * (never a real Stripe account): the company connected; Oakwood Dental paid a $480 invoice by
 * card and Hillside HOA $1,250 by bank transfer; one payout deposited both to Checking less
 * the stand-in's fees; a $195 invoice to Oakwood Dental is still open to pay from its link.
 */
export async function seedPhase10e(
  db: Db,
  config: AppConfig,
  userId: string,
  companyId: string,
): Promise<void> {
  if (config.PAYMENTS_PROVIDER !== 'mock') return;
  const lookup = await withTenant(db, { userId, companyId }, async (tx) => ({
    done: await tx
      .selectFrom('payment_accounts')
      .select('company_id')
      .where('company_id', '=', companyId)
      .executeTakeFirst(),
    checking: await tx
      .selectFrom('accounts')
      .select('id')
      .where('company_id', '=', companyId)
      .where('name', '=', 'Checking')
      .executeTakeFirst(),
    services: await tx
      .selectFrom('accounts')
      .select('id')
      .where('company_id', '=', companyId)
      .where('name', '=', 'Services')
      .executeTakeFirst(),
    customers: await tx
      .selectFrom('customers')
      .select(['id', 'display_name'])
      .where('company_id', '=', companyId)
      .execute(),
  }));
  const hillside = lookup.customers.find((c) => c.display_name === 'Hillside HOA');
  const oakwood = lookup.customers.find((c) => c.display_name === 'Oakwood Dental');
  if (lookup.done || !lookup.checking || !lookup.services || !hillside || !oakwood) return;

  const app = await NestFactory.createApplicationContext(
    AppModule.forRoot({ ...config, JOB_WORKER: 'off' }),
    { logger: ['error'] },
  );
  try {
    const auth: AuthContext = {
      sessionId: 'seed',
      userId,
      email: 'demo@example.com',
      fullName: 'Demo Owner',
      mfaEnrolled: true,
      mfaVerified: true,
    };
    const ctx: CompanyContext = { companyId, role: 'owner', permissions: PERMISSIONS };
    const meta: RequestMeta = { ip: null, userAgent: 'seed', requestId: null };
    const online = app.get(OnlinePaymentsService);
    const events = app.get(PaymentEventsService);
    const pay = app.get(PublicPayService);
    const sales = app.get(SalesDocumentsService);
    const standIn = (action: object) => events.webhook(Buffer.from(JSON.stringify(action)), {});
    const today = todayIso();

    await online.connect(auth, ctx, { depositAccountId: lookup.checking.id }, meta);
    const settings = await online.settings(auth, ctx);
    const accountId = settings.account!.accountId;
    await standIn({ action: 'finish_onboarding', accountId });

    const invoice = (customerId: string, number: string, description: string, amount: string) =>
      sales.save(
        auth,
        ctx,
        'invoice',
        null,
        salesDocumentInputSchema.parse({
          customerId,
          txnDate: addDays(today, -12),
          number,
          lines: [{ accountId: lookup.services!.id, description, amount }],
        }),
        meta,
      );
    const checkout = async (invoiceId: string) => {
      const { url } = await online.payLink(auth, ctx, invoiceId, meta);
      const session = await pay.checkout(url.split('/pay/')[1]!, {}, meta);
      return new URL(session.url).searchParams.get('session')!;
    };

    const spring = await invoice(oakwood.id, 'ONL-1001', 'Spring cleanup', '480');
    await standIn({ action: 'pay', sessionId: await checkout(spring.id), method: 'card' });

    const irrigation = await invoice(hillside.id, 'ONL-1002', 'Irrigation season start-up', '1250');
    const session = await checkout(irrigation.id);
    await standIn({ action: 'pay', sessionId: session, method: 'us_bank_account' });
    const bank = await withTenant(db, { userId, companyId }, (tx) =>
      tx
        .selectFrom('online_payments')
        .select('payment_intent_id')
        .where('session_id', '=', session)
        .executeTakeFirstOrThrow(),
    );
    await standIn({
      action: 'bank_result',
      paymentIntentId: bank.payment_intent_id,
      succeeded: true,
    });
    await standIn({ action: 'payout', accountId, arrivalDate: today });

    await invoice(oakwood.id, 'ONL-1003', 'Shrub trimming', '195');
  } finally {
    await app.close();
  }
}

/**
 * Demo of Phase 10f portals in Sample Landscaping Co.: the demo login is also linked to employee
 * Maria Lopez's portal (so /portal shows her pay stubs, W-2 figures and time without a second
 * login), and Maria has asked for a new W-4 (Payroll › Employee requests). Customers get their
 * sign-in links from Sales › Customers › Invite to customer portal (the email is printed by the
 * development mail transport).
 */
export async function seedPhase10f(
  db: Db,
  config: AppConfig,
  userId: string,
  companyId: string,
): Promise<void> {
  const lookup = await withTenant(db, { userId, companyId }, async (tx) => ({
    done: await tx
      .selectFrom('portal_links')
      .select('id')
      .where('company_id', '=', companyId)
      .executeTakeFirst(),
    maria: await tx
      .selectFrom('employees')
      .select('id')
      .where('company_id', '=', companyId)
      .where('first_name', '=', 'Maria')
      .where('last_name', '=', 'Lopez')
      .executeTakeFirst(),
    user: await tx
      .selectFrom('users')
      .select(['email'])
      .where('id', '=', userId)
      .executeTakeFirst(),
  }));
  if (lookup.done || !lookup.maria || !lookup.user) return;
  const maria = lookup.maria;

  // The link as if Maria's invitation had been accepted by the demo login.
  const link = await withTenant(db, { userId, companyId }, (tx) =>
    tx
      .insertInto('portal_links')
      .values({
        company_id: companyId,
        kind: 'employee',
        employee_id: maria.id,
        email: lookup.user!.email,
        expires_at: new Date(),
        invited_by: userId,
        user_id: userId,
        accepted_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow(),
  );

  const app = await NestFactory.createApplicationContext(
    AppModule.forRoot({ ...config, JOB_WORKER: 'off' }),
    { logger: ['error'] },
  );
  try {
    const auth: AuthContext = {
      sessionId: 'seed',
      userId,
      email: lookup.user.email,
      fullName: 'Demo Owner',
      mfaEnrolled: true,
      mfaVerified: true,
    };
    const meta: RequestMeta = { ip: null, userAgent: 'seed', requestId: null };
    await app.get(WorkerPortalService).requestW4(
      auth,
      { companyId, linkId: link.id, kind: 'employee', employeeId: maria.id, vendorId: null },
      {
        formVersion: '2020',
        effectiveFrom: `${new Date().getFullYear() + 1}-01-01`,
        filingStatus: 'married_jointly',
        multipleJobs: false,
        dependentsAmount: '4000',
        otherIncome: '0',
        deductions: '0',
        extraWithholding: '0',
        exempt: false,
        nonresidentAlien: false,
      },
      meta,
    );
  } finally {
    await app.close();
  }
}
