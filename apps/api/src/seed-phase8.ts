import { NestFactory } from '@nestjs/core';
import { withTenant, type Db } from '@acct/db';
import {
  bankAccountsInputSchema,
  employeeInputSchema,
  employeePayItemsInputSchema,
  employeePtoInputSchema,
  payrollItemInputSchema,
  payrollSettingsInputSchema,
  payScheduleInputSchema,
  PERMISSIONS,
  ptoPolicyInputSchema,
  stateRegistrationInputSchema,
  unemploymentRateInputSchema,
  vendorInputSchema,
  w4InputSchema,
  workersCompClassInputSchema,
} from '@acct/shared';
import { AppModule } from './app.module';
import type { AuthContext, CompanyContext, RequestMeta } from './common/request';
import type { AppConfig } from './config';
import { VendorsService } from './lists/customers-vendors.service';
import { EmployeesService } from './payroll/employees.service';
import { PayrollSetupService } from './payroll/payroll-setup.service';

/**
 * Demo of Phase 8 payroll setup in Sample Landscaping Co. (Austin, TX): payroll turned on, a
 * biweekly schedule, the Texas Workforce Commission registration with this year's rate, a
 * workers' comp class, a vacation policy, retirement and health items, and three employees:
 * - Maria Lopez: hourly crew lead, complete (SSN, W-4, direct deposit waiting for its prenote);
 * - David Chen: salaried office manager, paid by check, SSN not yet provided;
 * - Kim Nguyen: a new hire with only her job details entered.
 * The SSN is 078-05-1120, the number SSA voided after it was printed on a sample card.
 */
export async function seedPhase8(
  db: Db,
  config: AppConfig,
  userId: string,
  companyId: string,
): Promise<void> {
  const done = await withTenant(db, { userId, companyId }, (tx) =>
    tx
      .selectFrom('payroll_settings')
      .select('company_id')
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
    const checking = await withTenant(db, { userId, companyId }, (tx) =>
      tx
        .selectFrom('accounts')
        .select('id')
        .where('company_id', '=', companyId)
        .where('name', '=', 'Checking')
        .executeTakeFirstOrThrow(),
    );

    const setup = app.get(PayrollSetupService);
    await setup.setUp(auth, ctx, payrollSettingsInputSchema.parse({}), meta);
    await setup.updateSettings(
      auth,
      ctx,
      payrollSettingsInputSchema.parse({
        payrollStartDate: `${year}-01-01`,
        bankAccountId: checking.id,
        achOdfiRouting: '021000021',
        achOdfiName: 'First Example Bank',
        achCompanyName: 'Sample Landscapi',
      }),
      meta,
    );
    const schedule = await setup.saveSchedule(
      auth,
      ctx,
      null,
      payScheduleInputSchema.parse({
        name: 'Every other Friday',
        frequency: 'biweekly',
        firstPeriodEnd: `${year}-01-09`,
        payDateOffset: 6,
      }),
      meta,
    );
    const texas = await setup.saveRegistration(
      auth,
      ctx,
      null,
      stateRegistrationInputSchema.parse({ state: 'TX', unemploymentAccountNumber: '99-123456-7' }),
      meta,
    );
    // The employer's own rate from its (fictional) TWC notice, not a statutory rate.
    await setup.setUnemploymentRate(
      auth,
      ctx,
      texas.id,
      unemploymentRateInputSchema.parse({ year, rate: '2.7' }),
      meta,
    );
    const crew = await setup.saveWorkersComp(
      auth,
      ctx,
      null,
      workersCompClassInputSchema.parse({
        state: 'TX',
        code: '0042',
        description: 'Landscape gardening',
        rate: '4.85',
      }),
      meta,
    );
    const vacation = await setup.savePtoPolicy(
      auth,
      ctx,
      null,
      ptoPolicyInputSchema.parse({
        name: 'Vacation',
        kind: 'vacation',
        accrualMethod: 'per_hour_worked',
        accrualRate: '0.0385',
        maxBalance: '80',
      }),
      meta,
    );
    const plan = await app
      .get(VendorsService)
      .save(
        auth,
        ctx,
        null,
        vendorInputSchema.parse({ displayName: 'Summit Retirement Plans' }),
        meta,
      );
    const k401 = await setup.saveItem(
      auth,
      ctx,
      null,
      payrollItemInputSchema.parse({ name: '401(k)', kind: 'traditional_401k', vendorId: plan.id }),
      meta,
    );
    const health = await setup.saveItem(
      auth,
      ctx,
      null,
      payrollItemInputSchema.parse({ name: 'Health insurance (pre-tax)', kind: 'section_125' }),
      meta,
    );
    await setup.saveItem(
      auth,
      ctx,
      null,
      payrollItemInputSchema.parse({
        name: '401(k) match',
        kind: 'retirement_match',
        vendorId: plan.id,
      }),
      meta,
    );

    const employees = app.get(EmployeesService);
    const address = { city: 'Austin', state: 'TX', postalCode: '78701' };
    const work = { workCity: 'Austin', workState: 'TX', workPostalCode: '78701' };
    const maria = await employees.save(
      auth,
      ctx,
      null,
      employeeInputSchema.parse({
        employeeNumber: 'E-101',
        firstName: 'Maria',
        lastName: 'Lopez',
        ssn: '078-05-1120',
        addressLine1: '410 Cedar Ln',
        ...address,
        ...work,
        hireDate: `${year - 2}-04-11`,
        payType: 'hourly',
        payRate: '24.50',
        defaultHours: '80',
        payScheduleId: schedule.id,
        payMethod: 'direct_deposit',
        workersCompClassId: crew.id,
      }),
      meta,
    );
    await employees.addW4(
      auth,
      ctx,
      maria.id,
      w4InputSchema.parse({
        formVersion: '2020',
        effectiveFrom: `${year - 2}-04-11`,
        filingStatus: 'married_jointly',
        dependentsAmount: '4000',
      }),
      meta,
    );
    await employees.setBankAccounts(
      auth,
      ctx,
      maria.id,
      bankAccountsInputSchema.parse({
        accounts: [
          {
            routingNumber: '021000021',
            accountNumber: '000123456789',
            accountType: 'checking',
            amountType: 'remainder',
            prenote: true,
          },
        ],
      }),
      meta,
    );
    await employees.setPayItems(
      auth,
      ctx,
      maria.id,
      employeePayItemsInputSchema.parse({
        items: [
          { payrollItemId: k401.id, percent: '4' },
          { payrollItemId: health.id, amount: '85' },
        ],
      }),
      meta,
    );
    await employees.setPto(
      auth,
      ctx,
      maria.id,
      employeePtoInputSchema.parse({
        policies: [{ policyId: vacation.id, openingBalance: '24', openingAsOf: `${year}-01-01` }],
      }),
      meta,
    );

    const david = await employees.save(
      auth,
      ctx,
      null,
      employeeInputSchema.parse({
        employeeNumber: 'E-102',
        firstName: 'David',
        lastName: 'Chen',
        addressLine1: '88 Barton Springs Rd',
        ...address,
        ...work,
        hireDate: `${year - 1}-08-01`,
        payType: 'salary',
        payRate: '58000',
        defaultHours: '80',
        payScheduleId: schedule.id,
        overtimeExempt: true,
      }),
      meta,
    );
    await employees.addW4(
      auth,
      ctx,
      david.id,
      w4InputSchema.parse({
        formVersion: '2020',
        effectiveFrom: `${year - 1}-08-01`,
        filingStatus: 'single',
      }),
      meta,
    );

    await employees.save(
      auth,
      ctx,
      null,
      employeeInputSchema.parse({
        employeeNumber: 'E-103',
        firstName: 'Kim',
        lastName: 'Nguyen',
        ...work,
        hireDate: `${year}-09-14`,
        payType: 'hourly',
        payRate: '19',
        defaultHours: '60',
        payScheduleId: schedule.id,
        workersCompClassId: crew.id,
      }),
      meta,
    );
    console.log('Phase 8 demo: payroll setup and three employees added.');
  } finally {
    await app.close();
  }
}
