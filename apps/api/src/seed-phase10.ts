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
  itemInputSchema,
  PERMISSIONS,
  purchaseDocumentInputSchema,
  salesDocumentInputSchema,
} from '@acct/shared';
import { AppModule } from './app.module';
import type { AuthContext, CompanyContext, RequestMeta } from './common/request';
import type { AppConfig } from './config';
import { InventoryDocumentsService } from './inventory/inventory-documents.service';
import { ItemsService } from './lists/other-lists.service';
import { PurchaseDocumentsService } from './purchases/purchase-documents.service';
import { EstimatesService } from './sales/estimates.service';
import { SalesDocumentsService } from './sales/sales-documents.service';
import { TimeService } from './time/time.service';

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
    AppModule.forRoot({ ...config, REPORT_SCHEDULER: 'off' }),
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
    AppModule.forRoot({ ...config, REPORT_SCHEDULER: 'off' }),
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
