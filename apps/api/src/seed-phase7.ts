import { NestFactory } from '@nestjs/core';
import { withTenant, type Db } from '@acct/db';
import {
  budgetAmountsInputSchema,
  budgetInputSchema,
  customerUpdateSchema,
  itemInputSchema,
  memorizedReportInputSchema,
  PERMISSIONS,
  reportScheduleInputSchema,
  salesDocumentInputSchema,
  taxAgencyInputSchema,
  taxRateInputSchema,
} from '@acct/shared';
import { AppModule } from './app.module';
import { BudgetsService } from './budgets/budgets.service';
import type { AuthContext, CompanyContext, RequestMeta } from './common/request';
import type { AppConfig } from './config';
import { CustomersService } from './lists/customers-vendors.service';
import { ItemsService } from './lists/other-lists.service';
import { MemorizedReportsService } from './reports/memorized-reports.service';
import { SalesTaxService } from './sales-tax/sales-tax.service';
import { SalesDocumentsService } from './sales/sales-documents.service';

/**
 * Demo of Phase 7 in Sample Landscaping Co. (Austin, TX):
 * - sales tax: the Texas Comptroller, state and local rates combined as "Austin 8.25%", a taxable
 *   mulch item, Oakwood Dental charged tax on an April invoice;
 * - a budget for the year;
 * - memorized reports: a shared P&L by month, an A/R aging emailed every Monday, and a custom
 *   report of large expenses.
 */
export async function seedPhase7(
  db: Db,
  config: AppConfig,
  userId: string,
  companyId: string,
): Promise<void> {
  const done = await withTenant(db, { userId, companyId }, (tx) =>
    tx
      .selectFrom('tax_agencies')
      .select('id')
      .where('company_id', '=', companyId)
      .executeTakeFirst(),
  );
  if (done) return;

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
    const { accounts, customers } = await withTenant(db, { userId, companyId }, async (tx) => ({
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
    const acct = (name: string) => accounts.find((a) => a.name === name)!.id;

    // --- Sales tax --------------------------------------------------------------------------
    const tax = app.get(SalesTaxService);
    const comptroller = await tax.saveAgency(
      auth,
      ctx,
      null,
      taxAgencyInputSchema.parse({
        name: 'Texas Comptroller of Public Accounts',
        registrationNumber: '3-12345-6789-0',
        filingFrequency: 'quarterly',
      }),
      meta,
    );
    const single = (name: string, rate: string, description: string) =>
      tax.saveRate(
        auth,
        ctx,
        null,
        taxRateInputSchema.parse({
          name,
          kind: 'single',
          agencyId: comptroller.id,
          rate,
          description,
        }),
        meta,
      );
    const state = await single('Texas state', '6.25', 'State sales and use tax');
    const city = await single('Austin city', '1', 'City of Austin local sales tax');
    const transit = await single('Capital Metro', '1', 'Capital Metro transit authority');
    const austin = await tax.saveRate(
      auth,
      ctx,
      null,
      taxRateInputSchema.parse({
        name: 'Austin 8.25%',
        kind: 'combined',
        description: 'State, city and transit',
        componentIds: [state.id, city.id, transit.id],
      }),
      meta,
    );

    const mulch = await app.get(ItemsService).save(
      auth,
      ctx,
      null,
      itemInputSchema.parse({
        name: 'Mulch (per yard)',
        itemType: 'non_inventory',
        description: 'Hardwood mulch, delivered and spread',
        salesPrice: '45',
        incomeAccountId: acct('Sales'),
        taxable: true,
      }),
      meta,
    );
    const oakwood = customers.find((c) => c.display_name === 'Oakwood Dental')!.id;
    await app
      .get(CustomersService)
      .save(auth, ctx, oakwood, customerUpdateSchema.parse({ taxRateId: austin.id }), meta);
    await app.get(SalesDocumentsService).save(
      auth,
      ctx,
      'invoice',
      null,
      salesDocumentInputSchema.parse({
        customerId: oakwood,
        txnDate: `${year}-04-10`,
        taxRateId: austin.id,
        lines: [
          { itemId: mulch.id, quantity: '12', rate: '45', description: 'Front beds' },
          { accountId: acct('Services'), amount: '170', description: 'Bed preparation (labor)' },
        ],
      }),
      meta,
    );

    // --- Budget -------------------------------------------------------------------------------
    const budgets = app.get(BudgetsService);
    const budget = await budgets.create(
      auth,
      ctx,
      budgetInputSchema.parse({ name: `FY${year} budget`, startDate: `${year}-01-01` }),
      meta,
    );
    const monthly = (v: string, summer?: string) =>
      Array.from({ length: 12 }, (_, i) => (summer && i >= 3 && i <= 8 ? summer : v));
    await budgets.saveAmounts(
      auth,
      ctx,
      budget.id,
      budgetAmountsInputSchema.parse({
        rows: [
          { accountId: acct('Services'), amounts: monthly('3000', '5500') },
          { accountId: acct('Sales'), amounts: monthly('300', '900') },
          { accountId: acct('Rent and Lease'), amounts: monthly('1500') },
          { accountId: acct('Utilities'), amounts: monthly('180') },
          { accountId: acct('Car and Truck'), amounts: monthly('400', '650') },
          { accountId: acct('Advertising and Marketing'), amounts: monthly('150') },
        ],
      }),
      meta,
    );

    // --- Memorized reports --------------------------------------------------------------------
    const memorized = app.get(MemorizedReportsService);
    await memorized.create(
      auth,
      ctx,
      memorizedReportInputSchema.parse({
        name: 'P&L by month',
        reportKey: 'profit_and_loss',
        params: { datePreset: 'this_fiscal_year_to_date', columns: 'months' },
        shared: true,
      }),
      meta,
    );
    const aging = await memorized.create(
      auth,
      ctx,
      memorizedReportInputSchema.parse({
        name: 'Weekly A/R aging',
        reportKey: 'ar_aging_summary',
        params: { datePreset: 'today' },
      }),
      meta,
    );
    await memorized.setSchedule(
      auth,
      ctx,
      aging.id,
      reportScheduleInputSchema.parse({
        frequency: 'weekly',
        day: 1,
        hour: 8,
        timezone: 'America/Chicago',
        recipients: ['demo@example.com'],
        format: 'pdf',
      }),
      meta,
    );
    await memorized.create(
      auth,
      ctx,
      memorizedReportInputSchema.parse({
        name: 'Expenses over $500',
        reportKey: 'custom',
        params: {
          datePreset: 'this_fiscal_year_to_date',
          definition: {
            title: 'Expenses over $500',
            columns: ['date', 'txn_type', 'number', 'name', 'account', 'amount'],
            filters: { accountTypes: ['expense'], minAmount: '500' },
            groupBy: 'account',
          },
        },
      }),
      meta,
    );
    console.log('Phase 7 demo: sales tax (Austin 8.25%), a budget and memorized reports added.');
  } finally {
    await app.close();
  }
}
