import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { withTenant, type Db } from '@acct/db';
import { Inject } from '@nestjs/common';
import {
  closingPasswordSchema,
  eftpsEnrollSchema,
  payrollDepositFileSchema,
  prenoteFileInputSchema,
  standInDepositSchema,
  standInEftpsPaymentSchema,
  standInEnrollmentSchema,
  type AchBatchDto,
  type EftpsEnrollmentDto,
  type EmployeeDto,
  type PayrollLiabilityPaymentDto,
  type PayrollPartnersDto,
} from '@acct/shared';
import { CurrentAuth, CurrentCompany, Meta, RequirePermission } from '../../common/decorators';
import type { AuthContext, CompanyContext, RequestMeta } from '../../common/request';
import { UuidPipe } from '../../common/uuid.pipe';
import { ZodPipe } from '../../common/zod.pipe';
import { CompanyAccessGuard } from '../../companies/company-access.guard';
import { DB } from '../../db/db.module';
import { EmployeesService } from '../employees.service';
import { PayRunsService } from '../pay-runs.service';
import { DepositPartnerService } from './deposit-partner.service';
import { EftpsService } from './eftps.service';
import { PartnersPollerService } from './partners-poller.service';

type Parsed<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;

/**
 * EFTPS batch payments and partner direct deposits (ADR 0025). Reading needs `payroll.view`;
 * everything else `payroll.manage`.
 */
@Controller('companies/:companyId/payroll')
@UseGuards(CompanyAccessGuard)
export class PayrollPartnersController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly eftps: EftpsService,
    private readonly deposits: DepositPartnerService,
    private readonly poller: PartnersPollerService,
    private readonly runs: PayRunsService,
    private readonly employees: EmployeesService,
  ) {}

  @Get('partners')
  @RequirePermission('payroll.view')
  partners(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<PayrollPartnersDto> {
    return withTenant(this.db, { userId: a.userId, companyId: c.companyId }, async (tx) => {
      const s = await tx
        .selectFrom('payroll_settings')
        .select('deposit_rail')
        .where('company_id', '=', c.companyId)
        .executeTakeFirst();
      const e = this.eftps.provider;
      const d = this.deposits.partner;
      return {
        eftpsProvider: e ? { name: e.name, standIn: e.standIn } : null,
        enrollment: await this.eftps.enrollment(tx, c.companyId),
        depositPartner: d ? { name: d.name, standIn: d.standIn } : null,
        depositRail: (s?.deposit_rail ?? 'nacha_file') as PayrollPartnersDto['depositRail'],
      };
    });
  }

  /** Asks EFTPS and the payments partner now about this company's pending items. */
  @Post('partners/check')
  @HttpCode(200)
  @RequirePermission('payroll.manage')
  async check(@CurrentCompany() c: CompanyContext): Promise<{ changes: number }> {
    return { changes: await this.poller.pollAll(c.companyId) };
  }

  // --- EFTPS ------------------------------------------------------------------------------------
  @Post('eftps/enrollment')
  @RequirePermission('payroll.manage')
  enroll(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(eftpsEnrollSchema)) body: Parsed<typeof eftpsEnrollSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<EftpsEnrollmentDto | null> {
    return this.eftps.enroll(a, c, body, meta);
  }

  @Post('eftps/enrollment/cancel')
  @HttpCode(200)
  @RequirePermission('payroll.manage')
  cancelEnrollment(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Meta() meta: RequestMeta,
  ): Promise<EftpsEnrollmentDto | null> {
    return this.eftps.cancelEnrollment(a, c, meta);
  }

  @Post('eftps/enrollment/stand-in')
  @HttpCode(200)
  @RequirePermission('payroll.manage')
  standInEnrollment(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(standInEnrollmentSchema)) body: Parsed<typeof standInEnrollmentSchema>,
  ): Promise<EftpsEnrollmentDto | null> {
    return this.eftps.standInEnrollment(a, c, body);
  }

  @Post('liabilities/payments/:paymentId/cancel-eftps')
  @HttpCode(200)
  @RequirePermission('payroll.manage')
  cancelPayment(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('paymentId', UuidPipe) id: string,
    @Body(new ZodPipe(closingPasswordSchema)) body: Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PayrollLiabilityPaymentDto> {
    return this.eftps.cancelPayment(a, c, id, meta, body.closingPassword);
  }

  @Post('liabilities/payments/:paymentId/not-sent')
  @HttpCode(200)
  @RequirePermission('payroll.manage')
  paymentNotSent(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('paymentId', UuidPipe) id: string,
    @Body(new ZodPipe(closingPasswordSchema)) body: Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PayrollLiabilityPaymentDto> {
    return this.eftps.markNotSent(a, c, id, meta, body.closingPassword);
  }

  @Post('liabilities/payments/:paymentId/stand-in')
  @HttpCode(200)
  @RequirePermission('payroll.manage')
  standInPayment(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('paymentId', UuidPipe) id: string,
    @Body(new ZodPipe(standInEftpsPaymentSchema)) body: Parsed<typeof standInEftpsPaymentSchema>,
  ): Promise<PayrollLiabilityPaymentDto> {
    return this.eftps.standInPayment(a, c, id, body);
  }

  // --- Direct deposit partner ---------------------------------------------------------------------
  @Post('pay-runs/:runId/direct-deposits')
  @RequirePermission('payroll.manage')
  sendDeposits(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('runId', UuidPipe) runId: string,
    @Body(new ZodPipe(payrollDepositFileSchema)) body: Parsed<typeof payrollDepositFileSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<AchBatchDto> {
    return this.runs.sendDirectDeposits(a, c, runId, body, meta);
  }

  @Post('direct-deposit/prenotes/send')
  @RequirePermission('payroll.manage')
  sendPrenotes(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(prenoteFileInputSchema)) body: Parsed<typeof prenoteFileInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<AchBatchDto> {
    return this.employees.sendPrenotes(a, c, body, meta);
  }

  @Post('ach-batches/:batchId/not-sent')
  @HttpCode(200)
  @RequirePermission('payroll.manage')
  batchNotSent(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('batchId', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<AchBatchDto> {
    return this.deposits.markNotSent(a, c, id, meta);
  }

  @Post('ach-batches/:batchId/stand-in')
  @HttpCode(200)
  @RequirePermission('payroll.manage')
  standInBatch(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('batchId', UuidPipe) id: string,
    @Body(new ZodPipe(standInDepositSchema)) body: Parsed<typeof standInDepositSchema>,
  ): Promise<AchBatchDto> {
    return this.deposits.standIn(a, c, id, body);
  }

  @Post('employees/:id/bank-accounts/:accountId/clear-return')
  @HttpCode(200)
  @RequirePermission('payroll.manage')
  clearReturn(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Param('accountId', UuidPipe) accountId: string,
    @Meta() meta: RequestMeta,
  ): Promise<EmployeeDto> {
    return this.employees.clearDepositReturn(a, c, id, accountId, meta);
  }
}
